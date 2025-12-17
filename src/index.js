import { KTX2Decoder, ZSTDDecoder } from "@babylonjs/ktx2decoder";

import {
	Accessor,
	Extension,
	NodeIO,
	PropertyType,
	VertexLayout,
} from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS, EXTTextureWebP } from "@gltf-transform/extensions";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, unlink, readdir } from "node:fs/promises";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import sharp from "sharp";

import { default as initialize } from "./basis_transcoder.cjs";
import { generate_buffer, generate_texture } from "./deobfuscator.cjs"

const seedMapStartingState = {
	612168628: 0,
	1599883309: 3549,
	1761208024: 3174,
	1698286986: 21955,
	1689231785: 32123,
	1667373233: 5453,
	//New seedmap 17 Dec 25
	1764841611: 29199,
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

	try {
		const zlib = await import('node:zlib');
		return zlib.zstdDecompressSync(decryptedBody, { maxOutputLength: decodedSize });
	} catch(e) {
		console.log("zlib.zstdDecompress requires Node v23.8; fallback to ZSTDDecoder");
	}

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

	replaceX(x) {
		this._x = x
	}
}

class Deobfuscator {
	constructor(seed, version, timestamp) {
		this.seed = seed;
		this.version = version;
		this.timestamp = timestamp;
		this.someConstantIdk = BigInt("2352940687395663367")
		this.metaTextureData = this._generateMetaTexture();		
	}

	_generateMetaTexture() {
		console.log("Generating meta texture...");
		
		if (this.version === '5.0') {
			return generate_texture(BigInt(this.seed), this.someConstantIdk)
		}

		const prng = new RandomGenerator(this.seed);
		if (this.timestamp === "1599883309") {
			prng.replaceX(0x2567de00)
		}
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
		return [r / 255, g / 255, b / 255];
	}

	processVertexDisplacement(accessor, vertexCount, meta, processed) {
		const array = accessor.getArray();

		let adjustComponent;
		switch (this.version) {
			case "4.0", "5.0":
				adjustComponent = (value, meta) => {
					return value * (2 ** (meta / 8));
				};
				break;
			default:
				throw new Error(`Unknown obfuscation version: ${this.version}`);
		}


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

		let metaData;
		if (this.version === '5.0') {
			metaData = generate_buffer(BigInt(this.seed), this.someConstantIdk, 2 * vertexCount)
		} else {
			const randomGenerator = new RandomGenerator(this.seed);
			if (this.timestamp === "1599883309") {
				randomGenerator.replaceX(0x2567de00)
			}
			metaData = new Float32Array(2 * vertexCount);

			for (let i = 0; i < 2 * vertexCount; i++) {
				metaData[i] = (randomGenerator.nextInRange(256) + 0.5) / 256;
			}
		}

		const accessor = document.createAccessor();
		accessor.setType(Accessor.Type.VEC2);
		accessor.setArray(metaData);

		primitive.setAttribute("META", accessor);
	}

	processDocument(document) {
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

const makeSafeFilename = (name) => {
	return name.replace(/[<>:"\/\\|?*\u0000-\u001F]/g, (x) => {
		return '_x'+('0'+x.charCodeAt(0).toString(16)).substr(-2)+'_';
	});
}

const writeTexture = async (texture, suffix, buffer, ext) => {
	let name = texture.getName();
	const match = name.match(/^data:.*?\bbase64,(.+)(.)$/);
	if (match) {
		const data = Buffer.from(match[1], "base64");
		name = crypto.createHash("md5").update(data).digest("hex")+"_"+match[2];
		await writeFile(`./debug/${name}.${suffix}.base64.png`, data);
	}
	await writeFile(`./debug/${makeSafeFilename(name)}.${suffix}.${ext||"png"}`, buffer);
}

const VRM_EXTENSION_NAME = "VRM";
const PIXIV_EXTENSION_NAME = "PIXIV_vroid_hub_preview_mesh";
const PIXIV_BASIS_EXTENSION_NAME = "PIXIV_texture_basis";

// Base class - preserve respective json.extensions[] data
class PreservationExtension extends Extension {
	static EXTENSION_NAME = null;
	extensionName = null;

	read(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this.data = json.extensions[this.extensionName];
		return this;
	}

	// Write data during export
	write(context) {
		const jsonDoc = context.jsonDoc;
		const data = this.data;

		if (data) {
			jsonDoc.json.extensions = jsonDoc.json.extensions || {};
			jsonDoc.json.extensions[this.extensionName] = data;
			if (existsSync("./debug") === false) mkdir("./debug");
			writeFile(`./debug/${this.extensionName.toLowerCase()}.json`, JSON.stringify(data, null, 2));
		}

		return this;
	}
}

// Common pool for extensions that need textures to be patched first
class TexturePoolExtension extends PreservationExtension {
	static _vrmTextures = null;

	_saveTextures = (json) => {
		if (this._vrmTextures) return;
		this._vrmTextures = (json.textures||[]).map((t) => ({
			name: t.name,
			source: t.source,
			sampler: t.sampler,
		}));
	}

	_reapplyTextures = (json) => {
		if (!this._vrmTextures) return;
		const sourceToIdx = {};

		json.textures.forEach((tex, i) => sourceToIdx[tex.source] = i);
		this._vrmTextures.forEach(tex => {
			if (sourceToIdx[tex.source] !== undefined) {
				json.textures[sourceToIdx[tex.source]] = tex;
			} else {
				sourceToIdx[tex.source] = json.textures.push(tex) - 1;
			}
		});

		this._vrmTextures = null;
	}
}

export class VRM_v0_Extension extends TexturePoolExtension {
	static EXTENSION_NAME = VRM_EXTENSION_NAME;
	extensionName = VRM_EXTENSION_NAME;

	read(context) {
		super.read(context);
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._saveTextures(json);
		this.samplers = json.samplers || [];

		this.data.materialProperties ||= [];
		for (let mat of this.data.materialProperties) {
			if (!mat.textureProperties) continue;
			mat._textureSources = [];
			for (let prop in mat.textureProperties) {
				mat._textureSources[prop] = json.textures[mat.textureProperties[prop]].source;
			}
		}

		return this;
	}

	write(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._reapplyTextures(json);
		json.samplers = this.samplers || [];

		const sourceToIdx = {};
		json.textures.forEach((tex, i) => sourceToIdx[tex.source] = i);

		this.data.materialProperties ||= [];
		for (let mat of this.data.materialProperties) {
			if (!mat._textureSources) continue;
			for (let prop in mat._textureSources) {
				mat.textureProperties[prop] = sourceToIdx[mat._textureSources[prop]];
			}
			delete mat._textureSources;
		}

		super.write(context);

		return this;
	}
}

export class VRM_v1_Extension extends TexturePoolExtension {
	static EXTENSION_NAME = "VRMC_vrm";
	extensionName = "VRMC_vrm";

	read(context) {
		super.read(context);
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._saveTextures(json);
		this.samplers = json.samplers || [];

		return this;
	}

	write(context) {
		super.write(context);
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._reapplyTextures(json);
		json.samplers = this.samplers || [];

		return this;
	}
}

export class VRM_v1_materials_mtoon_Extension extends TexturePoolExtension {
	static EXTENSION_NAME = "VRMC_materials_mtoon";
	extensionName = "VRMC_materials_mtoon";
	prereadTypes = [PropertyType.MESH];
	prewriteTypes = [PropertyType.MESH];

	preread(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._saveTextures(json);

		this.materials_mtoon = {};
		for (let idx in json.materials) {
			let mat = json.materials[idx];
			if (!mat.extensions?.VRMC_materials_mtoon) continue;

			let ext = mat.extensions.VRMC_materials_mtoon;
			for (let k of Object.keys(ext)) {
				if (!k.match(/^.*Texture$/)) continue;
				ext[k]._source = json.textures[ext[k].index].source;
			}
			this.materials_mtoon[idx] = ext;
		}
	}

	prewrite(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._reapplyTextures(json);

		const sourceToIdx = {};
		json.textures.forEach((tex, i) => sourceToIdx[tex.source] = i);

		for (let mat of this.document.getRoot().listMaterials()) {
			const idx = context.materialIndexMap.get(mat);
			if (!this.materials_mtoon[idx]) continue;

			json.materials[idx].extensions ||= {};
			json.materials[idx].extensions.VRMC_materials_mtoon = this.materials_mtoon[idx];
			const ext = json.materials[idx].extensions.VRMC_materials_mtoon;

			for (let k of Object.keys(ext)) {
				if (!k.match(/^.*Texture$/)) continue;
				ext[k].index = sourceToIdx[ext[k]._source];
				delete ext[k]._source;
			}
		}
	}
}

export class VRM_v1_node_constraint_Extension extends PreservationExtension {
	static EXTENSION_NAME = "VRMC_node_constraint";
	extensionName = "VRMC_node_constraint";

	read(context) {
		super.read(context);
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this.node_constraint = {};
		for (let idx in json.nodes) {
			let node = json.nodes[idx];
			if (!node.extensions?.VRMC_node_constraint) continue;

			let ext = node.extensions.VRMC_node_constraint;
			this.node_constraint[idx] = ext;
		}
	}

	write(context) {
		super.write(context);
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		for (let node of this.document.getRoot().listNodes()) {
			const idx = context.nodeIndexMap.get(node);
			if (!this.node_constraint[idx]) continue;

			json.nodes[idx].extensions ||= {};
			json.nodes[idx].extensions.VRMC_node_constraint = this.node_constraint[idx];
		}
	}
}

export class VRM_v1_materials_hdr_emissiveMultiplier_Extension extends TexturePoolExtension {
	static EXTENSION_NAME = "VRMC_materials_hdr_emissiveMultiplier";
	extensionName = "VRMC_materials_hdr_emissiveMultiplier";
	prereadTypes = [PropertyType.MESH];
	prewriteTypes = [PropertyType.MESH];

	preread(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._saveTextures(json);

		this.emissiveMultiplier = {};
		for (let idx in json.materials) {
			let mat = json.materials[idx];
			if (!mat.extensions?.VRMC_materials_hdr_emissiveMultiplier) continue;

			let ext = mat.extensions.VRMC_materials_hdr_emissiveMultiplier;
			this.emissiveMultiplier[idx] = ext;
		}
	}

	prewrite(context) {
		const jsonDoc = context.jsonDoc;
		const json = jsonDoc.json;

		this._reapplyTextures(json);

		for (let mat of this.document.getRoot().listMaterials()) {
			const idx = context.materialIndexMap.get(mat);
			if (!this.emissiveMultiplier[idx]) continue;

			json.materials[idx].extensions ||= {};
			json.materials[idx].extensions.VRMC_materials_hdr_emissiveMultiplier = this.emissiveMultiplier[idx];
		}
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
		const textures = context.jsonDoc.json.textures || [];
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
		const options = {
			headers: {
				"X-Api-Version": "11",
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
			},
		};
		let response = await fetch(`https://hub.vroid.com/api/character_models/${id}/optimized_preview`, options);
		if (response.status === 404) {
			console.log('/optimized_preview not found, trying /preview')
			response = await fetch(`https://hub.vroid.com/api/character_models/${id}/preview`, options);
		}

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

	// Other subextensions that just need their json.extension[] data transferred
	// https://github.com/vrm-c/vrm-specification/tree/master/specification
	const VRM_v1_SubExtensions = [];
	const VRM_v1_SUBEXTENSION_NAMES = [
		"VRMC_springBone",
		"VRMC_springBone_limit",
		"VRMC_springBone_extended_collider",
		"VRMC_vrm_animation"
	]
	for (let extName of VRM_v1_SUBEXTENSION_NAMES) {
		VRM_v1_SubExtensions.push(
			class VRM_SubExtension extends PreservationExtension {
				static EXTENSION_NAME = extName;
				extensionName = extName;
			}
		)
	}

	const io = new NodeIO().registerExtensions([
		...KHRONOS_EXTENSIONS,
		EXTTextureWebP,
		VRM_v0_Extension,
		VRM_v1_Extension,
		VRM_v1_materials_mtoon_Extension,
		VRM_v1_node_constraint_Extension,
		VRM_v1_materials_hdr_emissiveMultiplier_Extension,
		PIXIVExtension,
		PIXIVBasisExtension,
	]).registerExtensions(
		VRM_v1_SubExtensions
	);

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
	const deobfuscator = new Deobfuscator(seed, version, timestamp);
	deobfuscator.processDocument(doc);

	const decoder = new KTX2Decoder();
	const { BasisFile, initializeBasis } = await initialize();
	initializeBasis();

	const textures = doc.getRoot().listTextures() || [];
	console.log("Decoding textures...");
	for (const texture of textures) {
		const image = texture.getImage();
		const mime = texture.getMimeType();

		if (!image) continue;

		if (mime === "image/ktx2") {
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

			await writeTexture(texture, "ktx2", pngBuffer);

			texture.setImage(pngBuffer);
			texture.setMimeType("image/png");
		} else if (mime === "image/basis") {

			const dv = new DataView(image.buffer, image.byteOffset, image.byteLength);
			const magic = dv.getUint32(0);
			if (magic === 0x89504e47) {
				console.log("Fixing mime type for PNG", texture.getName());
				texture.setMimeType("image/png");
				await writeTexture(texture, "png", image);
				continue;
			} else if (magic === 0xffd8ffdb || magic === 0xffd8ffe0 || magic === 0xffd8ffee || magic === 0xffd8ffe1) {
				console.log("Fixing mime type for JPEG", texture.getName());
				texture.setMimeType("image/jpeg");
				await writeTexture(texture, "jpeg", image, 'jpg');
				continue;
			}

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

			await writeTexture(texture, "basis", pngBuffer);

			texture.setImage(pngBuffer);
			texture.setMimeType("image/png");
		} else if (mime === "image/png") {

			const dv = new DataView(image.buffer, image.byteOffset, image.byteLength);
			const magic = dv.getUint32(0);
			
			if (magic === 0x52494646) {
				console.log("Convering WEBP to PNG:", texture.getName());
				const pngBuffer = await sharp(image)
					.png({ compressionLevel: 9, adaptiveFiltering: true, force: true })
					.toBuffer();
				texture.setImage(pngBuffer);
				await writeTexture(texture, "webp", pngBuffer);
			}
		}
	}

	io.setVertexLayout(VertexLayout.SEPARATE);
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
