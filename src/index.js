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
import { mkdir, writeFile, readFile, unlink, readdir, rm } from "node:fs/promises";
import vm from "node:vm"
import crypto from "node:crypto";
import sharp from "sharp";
import { setGlobalDispatcher, Agent } from 'undici';
import { unpack } from "webcrack-unpacker";

import { default as initialize } from "./basis_transcoder.cjs";
import { generate_buffer, generate_texture } from "./deobfuscator.cjs"

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

async function fetchText(url) {
	const headers = {
  		'User-Agent': "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  		'Accept': '*/*',
  		'Accept-Language': 'en-US,en;q=0.9',
  		'Accept-Encoding': 'identity',
	};
	
	const response = await fetch(url, { headers })
	if (!response.ok) {
		throw new Error(`Couldn't get ${url}, status code: ${response.status}`)
	}
	return response.text()
}

function regexMatch(string, regex) {
	const match = string.match(regex)
	if (match === null) {
		throw new Error("Couldn't match regex")
	}
	match.shift()
	return match
}

async function fetchSeedMapModule() {
	console.log("Fetching seed map generation module...");

	const baseUrl = "https://hub.vroid.com"

	const html = await fetchText(`${baseUrl}/en`)
	const [ webpackJsPath ] = regexMatch(html, /<script src="(\/_next\/static\/chunks\/webpack-[\da-f]{16}\.js)"/)
	
	const webpackJs = await fetchText(baseUrl + webpackJsPath)
	const [ modelViewerNumId ] = regexMatch(webpackJs, /(\d+):"ModelViewer"/)
	const [ modelViewerHexId ] = regexMatch(webpackJs, new RegExp(`${modelViewerNumId}:"([\\da-f]{16})"`))

	const modelViewerJs = await fetchText(`${baseUrl}/_next/static/chunks/ModelViewer.${modelViewerHexId}.js`)

	const unpacked = await unpack(modelViewerJs)

	let moduleJs;
	for (const module of unpacked.bundle.modules) {
    	// check for custom base64 alphabet injected by obfuscator.
    	// if the module is obfuscated, it's probably the seedmap gen code :3
    	if (module[1].code.includes('"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/="')) {
        	console.log(`Found seed map gen module: ${module[1].id}`)
        	moduleJs = module[1].code
    	}
	}

	if (moduleJs === undefined) {
		throw new Error("Seed map gen module not found")
	}

	return moduleJs
}

// vroid hub adds new timestamps fairly often in an obfuscated JS module, so instead of
// reimplementing it ourselves it's better to just fetch their code and run it :)
const computeSeedMap = async (inputValue, url) => {
	let moduleJs
	if (existsSync("./cache/seedmapModule.js")) {
		moduleJs = await readFile("./cache/seedmapModule.js", 'utf8')
	} else {
		moduleJs = await fetchSeedMapModule()
		await writeFile("./cache/seedmapModule.js", moduleJs)
	}

	console.log("Computing seed map...")

	const seedmapFuncRegex = /^export let ([\w$]+) = async (\([\w$\s,]+\)) =>/m
	const [ seedmapFuncName, seedmapFuncArgs ] = regexMatch(moduleJs, seedmapFuncRegex)

	// epic hack since es modules can't be run under node's vm thingy
	moduleJs = moduleJs.replace(seedmapFuncRegex, `async function ${seedmapFuncName} ${seedmapFuncArgs}`)

	const context = {
    	// setInterval is used for some anti-debugging crap, we can just stub this one
    	setInterval: function(){},
    	window: {
    	    crypto: {
    	        subtle: crypto.subtle
    	    }
    	},
    	TextEncoder
	};
	vm.createContext(context);
	vm.runInContext(moduleJs, context);

	// console.log("seedMapStartingState", await context[seedmapFunctionName]("0", ""))
	return await context[seedmapFuncName](inputValue, url)
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

const multiplyQuaternions = (a, b) => {
	const ax = a[0], ay = a[1], az = a[2], aw = a[3];
	const bx = b[0], by = b[1], bz = b[2], bw = b[3];
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
};

const rotateVectorByQuaternion = (vec, quat) => {
	const vx = vec[0], vy = vec[1], vz = vec[2];
	const qx = quat[0], qy = quat[1], qz = quat[2], qw = quat[3];
	const uv = [
		qy * vz - qz * vy,
		qz * vx - qx * vz,
		qx * vy - qy * vx,
	];
	const uuv = [
		qy * uv[2] - qz * uv[1],
		qz * uv[0] - qx * uv[2],
		qx * uv[1] - qy * uv[0],
	];
	return [
		vx + 2 * (qw * uv[0] + uuv[0]),
		vy + 2 * (qw * uv[1] + uuv[1]),
		vz + 2 * (qw * uv[2] + uuv[2]),
	];
};

const rotateSceneForward = (doc) => {
	const flipQuat = [0, 1, 0, 0];
	const rootNodes = new Set();
	for (const scene of doc.getRoot().listScenes()) {
		for (const node of scene.listChildren()) {
			rootNodes.add(node);
		}
	}

	for (const node of rootNodes) {
		const translation = node.getTranslation();
		if (translation) {
			node.setTranslation(rotateVectorByQuaternion(translation, flipQuat));
		}

		const rotation = node.getRotation();
		if (rotation) {
			node.setRotation(multiplyQuaternions(flipQuat, rotation));
		} else {
			node.setRotation([...flipQuat]);
		}
	}
};

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
		prng.replaceX(0x2567de00)
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
			randomGenerator.replaceX(0x2567de00)
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

async function get_user_model_ids(id) {
	let model_ids = [];
	let api_url = `https://hub.vroid.com/api/users/${id}/character_models?antisocial_or_hate_usage=&characterization_allowed_user=&corporate_commercial_use=&credit=&modification=&personal_commercial_use=&political_or_religious_usage=&redistribution=&sexual_expression=&violent_expression=`;
	
	//console.log(await response.json());
	while(api_url)
	{
		let response = await fetch(api_url, options);
		let model_list = await response.json();
		if(model_list._links.next)
		{
			api_url = "https://hub.vroid.com"+model_list._links.next.href;
		}else{
			api_url = null;
		}
		model_list.data.forEach(model => {
			model_ids.push(model.id);
		});
	}
	return model_ids
}

async function download_model_info(id) {
	let jsonData = null;
	setGlobalDispatcher(new Agent({
		allowH2: true
	}));
	let response = await fetch(`https://hub.vroid.com/api/character_models/${id}`, options);
	jsonData = await response.json();
	if (!user_match){
		user_id = jsonData.data.character_detail.user_detail.user.id;
	}
	
	
	user_dir = `./${cache_dir}/${user_id}`;
	if (existsSync(user_dir) === false) await mkdir(user_dir);
	let model_data_dir = `./${cache_dir}/${user_id}/${id}`;
	if (existsSync(model_data_dir) === false) await mkdir(model_data_dir);

	const info_json_path=`${model_data_dir}/info.json`;
	const full_body_path=`${model_data_dir}.png`;

	await writeFile(info_json_path, JSON.stringify(jsonData, null, 2));
	console.log("user_id",user_id);
	//download full body image
	if (existsSync(full_body_path) === false) {
		console.log("Download full Body image");
		let full_body_req = await fetch(jsonData.data.character_model.full_body_image.original.url);
		let bufferData = await full_body_req.arrayBuffer();
		await writeFile(full_body_path,Buffer.from(bufferData));
	}
}

async function deobfuscateVRoidHubGLB(id) {
	await download_model_info(id);
	console.log("Starting deobfuscation process for VRoid Hub GLB...");

	// vroid hub blocks HTTP/1.1 requests, so we have to enable HTTP/2
	setGlobalDispatcher(new Agent({
		allowH2: true
	}));

	let vrmData = null;
	let vrmUrl = null;

	if (existsSync("./debug") === true) {
		console.log("Cleaning up debug folder...");
		const files = await readdir("./debug");
		for (const file of files) {
			await unlink(`./debug/${file}`);
		}
	} else {
		await mkdir("./debug");
	}

	//if (existsSync("./cache") === false) await mkdir("./cache");
	//if (existsSync(`./cache/${id}.json`) === true) {
	if (existsSync(`./${cache_dir}/${user_id}/${id}/${id}.json`) === true) {
		//console.log(`Loading cached GLB for ID: ${id}...`);
		//const vrmInfo = JSON.parse(await readFile(`./cache/${id}.json`, "utf-8"));
		//vrmUrl = vrmInfo.url;
		//const vrmPath = `./cache/${id}.glb`;
		console.log(`Loading cached GLB for ID: ${id}...`);
		const vrmInfo = JSON.parse(await readFile(`./${cache_dir}/${user_id}/${id}/${id}.json`, "utf-8"));
		const vrmPath = `./${cache_dir}/${user_id}/${id}/${id}.glb`;
		console.log("file exit json")
		vrmData = await readFile(vrmPath);
	} else {
		console.log(`Fetching VRM data for ID: ${id}...`);
		
		//const options = {
		//	headers: {
		//		"X-Api-Version": "11",
		//		"User-Agent":
		//			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
		//	},
		//};
		let response = await fetch(`https://hub.vroid.com/api/character_models/${id}/optimized_preview`, options);
		if (response.status === 404) {
			console.log('/optimized_preview not found, trying /preview')
			response = await fetch(`https://hub.vroid.com/api/character_models/${id}/preview`, options);
		}
		if (response.status === 403) {
			console.log("get failed")
		}
		vrmData = await response.arrayBuffer();
		//const vrmPath = `./cache/${id}.glb`;
		//const vrmInfoPath = `./cache/${id}.json`;
		const vrmPath = `./${cache_dir}/${user_id}/${id}/${id}.glb`;
		const vrmInfoPath = `./${cache_dir}/${user_id}/${id}/${id}.json`;

		//if (!response.ok) throw new Error("Failed to grab the encrypted VRM.");
		if (!response.ok){
			error_list.push(id);
			return null;
		}

		vrmData = await decryptAndDecodeVRMFile(vrmData);

		vrmUrl = response.url;
		await writeFile(vrmPath, vrmData);
		await writeFile(
			vrmInfoPath,
			JSON.stringify({ id, url: vrmUrl }, null, 2),
		);
		console.log(`Fetched and decrypted VRM data for ID: ${id}.`);
	}

	let seedMap = await computeSeedMap(id, vrmUrl);

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

	let seed = seedMap[timestamp];

	if (seed === undefined) {
		console.log(`Seed not found for timestamp ${timestamp}, fetching new seedmap gen module...`)
		await rm("./cache/seedmapModule.js")
		seedMap = await computeSeedMap(id, vrmUrl);

		seed = seedMap[timestamp]

		if (seed === undefined) {
			throw new Error(`Seed not found for timestamp: ${timestamp}`);
		}
	}
	console.log(seedMap);
	const deobfuscator = new Deobfuscator(seed, version, timestamp);
	deobfuscator.processDocument(doc);
	// VRoid preview GLBs face +Z; rotate 180° so exported VRMs look toward -Z like Unity/VRM expect.
	rotateSceneForward(doc);

	const decoder = new KTX2Decoder();
	const { BasisFile, initializeBasis } = await initialize();
	initializeBasis();

	const textures = doc.getRoot().listTextures() || [];
	console.log("Decoding textures...");
	for (const texture of textures) {
		break;//jump export tex
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
	//writeFile(`./${id}.deob.vrm`, outputGLB);
	writeFile(`./${cache_dir}/${user_id}/${id}/${id}.deob.vrm`, outputGLB);

	console.log(
		`Deobfuscation process for VRoid Hub GLB with ID: ${id} completed.`,
	);
	return outputGLB;
}

const parseVRoidHubURL = (url) =>
	url.replace(/\/+$/, "").split("/").slice(-1)[0];

//const target = process.argv.slice(-1)[0];
//if (!target.startsWith("https://") && Number.isNaN(Number.parseInt(target))) {
//	throw new Error("That's not a valid VRoid Hub URL.");
//}

//deobfuscateVRoidHubGLB(parseVRoidHubURL(target));

const cache_dir = "./cache";
let user_dir;
let user_id;
const target = process.argv.slice(-1)[0];
const options = {
	headers: {
		"X-Api-Version": "11",
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
		"Referer": "https://hub.vroid.com/en/characters/2533837067352303068/models/5292605813764344136",
		"Cookie": "_ga=GA1.2.1425015193.1771948677; _gid=GA1.2.108538913.1774188397; cf_clearance=6iYMdhQX_SBSAgZ.XWoFVVckYV0saqxnhIoVDFqVfB0-1774187042-1.2.1.1-_MMDtdfwWc2kVv3LsFGwkb4ucD36yqh6j_RV4SJTBQtjboGygJOveDhW6as6xgsZ7CJdfeAWw9SsKxMtOvmiFBTfkROjsKcb1D0zTpieijR3zutcO7RBMM6RPQHNUnM8_cWAaOeYrHRvkl2Dzw8WJPMjSJtdygCkm3orlJbKZJPZK.t3wzuclCi_aDvSymLTz9sUJjYLgoJ5TaQNeTHxxS9kEmiKNqSCxJspgEsDfPE; ...", // 保留有效 cookie
	},
};
const BASE_PART = "(?:https?:\\/\\/)?hub\\.vroid\\.com\\/(?:[a-z]{2}\\/)?";
// VROID_USER 
const VROID_USER_PATTERN = BASE_PART + "users\\/(\\d+)";
const vroidUserRegex = new RegExp(VROID_USER_PATTERN);
const user_match=target.match(vroidUserRegex);
// VROID_MODEL 
const VROID_MODEL_PATTERN = BASE_PART + "characters\\/(\\d+)\\/models\\/(\\d+)";
const vroidModelRegex = new RegExp(VROID_MODEL_PATTERN);
const model_match=target.match(vroidModelRegex);
if (existsSync(cache_dir) === false) await mkdir(cache_dir);

let error_list = [];
if(user_match)
{
	user_id = user_match[1];
	let model_ids = await get_user_model_ids(user_id);
	console.log(`user ${user_id} have model ${model_ids.length}`);
	for (let model_id of model_ids) {
		console.log("Processing model:", model_id);
		const outputPath = `./${cache_dir}/${user_id}/${model_id}/${model_id}.deob.vrm`;
		if (!existsSync(outputPath)) {
			try {
				await deobfuscateVRoidHubGLB(model_id);
			} catch (err) {
				console.error(`Failed to process ${model_id}:`, err.message);
				error_list.push(model_id);
			}
		} else {
			console.log(`Skipping (already exists): ${model_id}`);
		}
		await sleep(5000);
	}
	if(error_list){
		console.log("error list",error_list);
	}
	process.exit();
}
if (model_match)
{
	console.log("Single Model Download Mode!");
	const chara_id = model_match[1];
	const model_id = model_match[2];
	deobfuscateVRoidHubGLB(model_id);
}

function sleep(time) {
	return new Promise(resolve => setTimeout(resolve, time));
}
