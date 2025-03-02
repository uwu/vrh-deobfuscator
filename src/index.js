import { KTX2Decoder, ZSTDDecoder } from "@babylonjs/ktx2decoder";

import {
	Accessor,
	Extension,
	NodeIO,
	PropertyType,
} from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, unlink, readdir } from "node:fs/promises";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import sharp from "sharp";

import { default as initialize } from "./basis_transcoder.cjs";

const seedMapStartingState = {
	1698286986: 21955,
	1689231785: 32123,
	1667373233: 5453,
	legacy: 0,
};

const decryptAndDecodeVRMFile = async (fileContents) => {
	console.log("Starting to decrypt and decode VRM file...");
	const iv = fileContents.slice(0, 16);
	const keyBytes = fileContents.slice(16, 48);
	const fileBody = fileContents.slice(48, fileContents.byteLength);

	const decryptionKey = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		"AES-CBC",
		true,
		["decrypt"],
	);

	const decrypted = await crypto.subtle.decrypt(
		{
			name: "AES-CBC",
			iv,
		},
		decryptionKey,
		fileBody,
	);

	const decodedSize = new DataView(decrypted.slice(0, 4)).getUint32(0, true);
	const decryptedBody = new Uint8Array(decrypted.slice(4));

	const decoder = new ZSTDDecoder();
	await decoder.init();

	const decoded = decoder.decode(decryptedBody, decodedSize);
	return decoded;
};

const computeSeedMap = async (inputValue, url) => {
	console.log("Computing seed map...");
	if (url?.includes("s=op")) {
		const apiVersionOffset = ["/v1/", "/v2/"].some((prefix) =>
			url.includes(prefix),
		)
			? 6
			: 5;
		const path = url.split("/").slice(apiVersionOffset).join("/");

		const hash = createHash("sha1");
		hash.update(new TextEncoder().encode(path));
		const hashBuffer = hash.digest().buffer;

		const hashInt = new DataView(hashBuffer).getInt32(
			hashBuffer.byteLength - 4,
			true,
		);
		return Object.fromEntries(
			Object.entries(seedMapStartingState).map(([key, value]) => [
				key,
				value + hashInt,
			]),
		);
	}

	return Object.fromEntries(
		Object.entries(seedMapStartingState).map(([key, value]) => [
			key,
			value + Number.parseInt(inputValue, 10),
		]),
	);
};

class RandomGenerator {
	constructor(seed = 0x5491333) {
		this._x = 0x75bcd15;
		this._y = 0x159a55e5;
		this._z = 0x1f123bb5;
		this._w = seed;
	}

	next() {
		return Math.abs(this._next()) / 0x80000000;
	}

	nextInRange(range) {
		return Math.floor(range * this.next()) % range;
	}

	_next() {
		const temp = this._x ^ (this._x << 11);
		this._x = this._y;
		this._y = this._z;
		this._z = this._w;
		this._w = this._w ^ (this._w >>> 19) ^ (temp ^ (temp >>> 8));
		return this._w;
	}
}

class Deobfuscator {
	constructor(seed) {
		this.seed = seed;
		this.metaTextureData = this._generateMetaTexture(seed);
		this.prng = new RandomGenerator(seed);
	}

	_generateMetaTexture(seed) {
		console.log("Generating meta texture...");
		const prng = new RandomGenerator(seed);
		const data = new Uint8Array(256 * 256 * 4);
		for (let i = 0; i < 256 * 256; i++) {
			data[i * 4] = prng.nextInRange(256); // R
			data[i * 4 + 1] = prng.nextInRange(256); // G
			data[i * 4 + 2] = prng.nextInRange(256); // B
			data[i * 4 + 3] = 255; // A
		}
		return data;
	}

	_getMetaPosition(uVal, vVal) {
		const index = (vVal * 256 + uVal) * 4;
		const r = this.metaTextureData[index];
		const g = this.metaTextureData[index + 1];
		const b = this.metaTextureData[index + 2];
		return [r / (255 * 16), g / (255 * 16), b / (255 * 16)];
	}

	processVertexDisplacement(accessor, vertexCount, meta, processed) {
		const array = accessor.getArray();

		const adjustComponent = (value, meta) => {
			return value - Math.sign(value) * meta;
		};

		for (let i = 0; i < vertexCount; i++) {
			const uVal = Math.floor(meta[i * 2] * 256);
			const vVal = Math.floor(meta[i * 2 + 1] * 256);
			const [x, y, z] = this._getMetaPosition(uVal, vVal);

			if (
				processed[0].has(array[i * 3]) &&
				processed[1].has(array[i * 3 + 1]) &&
				processed[2].has(array[i * 3 + 2])
			) {
				continue;
			}

			array[i * 3] = adjustComponent(array[i * 3], x);
			array[i * 3 + 1] = adjustComponent(array[i * 3 + 1], y);
			array[i * 3 + 2] = adjustComponent(array[i * 3 + 2], z);

			processed[0].add(array[i * 3]);
			processed[1].add(array[i * 3 + 1]);
			processed[2].add(array[i * 3 + 2]);
		}

		accessor.setArray(array);
	}

	processPrimitive(document, primitive) {
		const vertexCount = primitive.getAttribute("POSITION").getCount();
		const randomGenerator = new RandomGenerator(this.seed);
		const metaData = new Float32Array(2 * vertexCount);

		for (let i = 0; i < 2 * vertexCount; i++) {
			metaData[i] = (randomGenerator.nextInRange(256) + 0.5) / 256;
		}

		const accessor = document.createAccessor();
		accessor.setType(Accessor.Type.VEC2);
		accessor.setArray(metaData);

		primitive.setAttribute("META", accessor);
	}

	processDocument(document, version) {
		const root = document.getRoot();

		for (const mesh of root.listMeshes()) {
			for (const primitive of mesh.listPrimitives()) {
				this.processPrimitive(document, primitive);
			}
		}

		const processed = [new Set(), new Set(), new Set()];

		console.log("Processing vertex displacement...");
		for (const mesh of root.listMeshes()) {
			for (const primitive of mesh.listPrimitives()) {
				const position = primitive.getAttribute("POSITION");
				if (!position) {
					continue;
				}

				const meta = primitive.getAttribute("META");
				const vertexCount = position.getCount();
				this.processVertexDisplacement(
					position,
					vertexCount,
					meta.getArray(),
					processed,
				);

				meta.dispose();
			}
		}
	}
}

const VRM_EXTENSION_NAME = "VRM";
const PIXIV_EXTENSION_NAME = "PIXIV_vroid_hub_preview_mesh";
const PIXIV_BASIS_EXTENSION_NAME = "PIXIV_texture_basis";

export class VRMPreservationExtension extends Extension {
	static EXTENSION_NAME = VRM_EXTENSION_NAME;
	extensionName = VRM_EXTENSION_NAME;

	read(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this.vrmExt = json.extensions.VRM;
		this.textures = json.textures.map((t) => ({
			source: t.source,
			sampler: t.sampler,
		}));
		return this;
	}

	// Write VRM data during export
	write(context) {
		const jsonDoc = context.jsonDoc;
		const vrmData = this.vrmExt;

		if (vrmData) {
			jsonDoc.json.extensions = jsonDoc.json.extensions || {};
			jsonDoc.json.extensions[this.extensionName] = vrmData;
		}

		if (existsSync("./debug") === false) mkdir("./debug");
		writeFile("./debug/vrm.json", JSON.stringify(vrmData, null, 2));

		jsonDoc.json.textures = this.textures;

		return this;
	}
}

export class PIXIVExtension extends Extension {
	static EXTENSION_NAME = PIXIV_EXTENSION_NAME;
	extensionName = PIXIV_EXTENSION_NAME;

	read(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this.data = json.extensions[PIXIV_EXTENSION_NAME];

		return this;
	}

	write() {
		throw "This extension must be removed prior to writing.";
	}
}

export class PIXIVBasisExtension extends Extension {
	static EXTENSION_NAME = PIXIV_BASIS_EXTENSION_NAME;
	extensionName = PIXIV_BASIS_EXTENSION_NAME;
	prereadTypes = [PropertyType.TEXTURE];

	preread(context) {
		console.log("Detected PIXIV basis extension, fixing it up...");
		const textures = context.jsonDoc.json.textures;
		for (const texture of textures) {
			if (texture.extensions?.PIXIV_texture_basis) {
				texture.source = texture.extensions.PIXIV_texture_basis.source;
			}
		}

		context.jsonDoc.json.textures = textures;

		return this;
	}

	read() {}
	write() {
		throw "This extension must be removed prior to writing.";
	}
}

async function deobfuscateVRoidHubGLB(id) {
	console.log("Starting deobfuscation process for VRoid Hub GLB...");

	let vrmData = null;
	let seedMap = null;

	if (existsSync("./debug") === true) {
		console.log("Cleaning up debug folder...");
		const files = await readdir("./debug");
		for (const file of files) {
			await unlink(`./debug/${file}`);
		}
	} else {
		await mkdir("./debug");
	}

	if (existsSync("./cache") === false) await mkdir("./cache");
	if (existsSync(`./cache/${id}.json`) === true) {
		console.log(`Loading cached GLB for ID: ${id}...`);
		const vrmInfo = JSON.parse(await readFile(`./cache/${id}.json`, "utf-8"));
		const vrmPath = `./cache/${id}.glb`;
		vrmData = await readFile(vrmPath);
		seedMap = await computeSeedMap(id, vrmInfo.url);
	} else {
		console.log(`Fetching VRM data for ID: ${id}...`);
		const response = await fetch(
			`https://hub.vroid.com/api/character_models/${id}/optimized_preview`,
			{
				headers: {
					"X-Api-Version": "11",
					"User-Agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
				},
			},
		);

		vrmData = await response.arrayBuffer();
		const vrmPath = `./cache/${id}.glb`;
		const vrmInfoPath = `./cache/${id}.json`;

		if (!response.ok) throw new Error("Failed to grab the encrypted VRM.");

		vrmData = await decryptAndDecodeVRMFile(vrmData);

		await writeFile(vrmPath, vrmData);
		await writeFile(
			vrmInfoPath,
			JSON.stringify({ id, url: response.url }, null, 2),
		);
		seedMap = await computeSeedMap(id, response.url);
		console.log(`Fetched and decrypted VRM data for ID: ${id}.`);
	}

	const io = new NodeIO().registerExtensions([
		...KHRONOS_EXTENSIONS,
		VRMPreservationExtension,
		PIXIVExtension,
		PIXIVBasisExtension,
	]);

	// Read the GLB file
	console.log("Reading GLB file...");
	const doc = await io.readBinary(vrmData);
	const extensions = doc.getRoot().listExtensionsUsed();
	const basisUExtension = extensions.find(
		(ext) => ext.extensionName === "KHR_texture_basisu",
	);
	basisUExtension?.dispose();

	const pixivExtension = extensions.find(
		(ext) => ext.extensionName === PIXIV_EXTENSION_NAME,
	);
	const { timestamp, version } = pixivExtension.data;
	pixivExtension?.dispose();

	const pixivBasisExtension = extensions.find(
		(ext) => ext.extensionName === PIXIV_BASIS_EXTENSION_NAME,
	);
	pixivBasisExtension?.dispose();

	console.log("Obfuscation version and timestamp:", version, timestamp);

	const seed = seedMap[timestamp];

	if (seed === undefined) {
		throw new Error(`Seed not found for timestamp: ${timestamp}`);
	}
	const deobfuscator = new Deobfuscator(seed);
	deobfuscator.processDocument(doc, version);

	const decoder = new KTX2Decoder();
	const { BasisFile, initializeBasis } = await initialize();
	initializeBasis();

	const textures = doc.getRoot().listTextures();
	console.log("Decoding textures...");
	for (const texture of textures) {
		const image = texture.getImage();

		if (!image) continue;

		if (texture.getMimeType() === "image/ktx2") {
			const decoded = await decoder.decode(image, {
				ASTC: true,
				BC7: true,
				ETC2: true,
				ETC1S: true,
				PVRTC: true,
				S3TC: true,
				UASTC: true,
			});

			const pngBuffer = await sharp(decoded.mipmaps[0].data, {
				raw: {
					width: decoded.width,
					height: decoded.height,
					channels: 4,
				},
			})
				.png()
				.toBuffer();

			await writeFile(`./debug/${texture.getName()}.ktx2.png`, pngBuffer);

			texture.setImage(pngBuffer);
			texture.setMimeType("image/png");
		} else if (texture.getMimeType() === "image/basis") {
			const basisFile = new BasisFile(image);

			const width = basisFile.getImageWidth(0, 0);
			const height = basisFile.getImageHeight(0, 0);
			basisFile.startTranscoding();

			const dstSize = width * height * 4;
			const dst = new Uint8Array(dstSize);

			if (!basisFile.transcodeImage(dst, 0, 0, 13, 0, 0)) {
				throw new Error("Failed to transcode image");
			}

			const pngBuffer = await sharp(dst, {
				raw: {
					width,
					height,
					channels: 4,
				},
			})
				.png()
				.toBuffer();

			await writeFile(`./debug/${texture.getName()}.basis.png`, pngBuffer);

			texture.setImage(pngBuffer);
			texture.setMimeType("image/png");
		}
	}

	const outputGLB = await io.writeBinary(doc);
	writeFile(`./${id}.deob.vrm`, outputGLB);

	console.log(
		`Deobfuscation process for VRoid Hub GLB with ID: ${id} completed.`,
	);
	return outputGLB;
}

const parseVRoidHubURL = (url) =>
	url.replace(/\/+$/, "").split("/").slice(-1)[0];

const target = process.argv.slice(-1)[0];
if (!target.startsWith("https://") && Number.isNaN(Number.parseInt(target))) {
	throw new Error("That's not a valid VRoid Hub URL.");
}

deobfuscateVRoidHubGLB(parseVRoidHubURL(target));
