import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';
import { Canvas, Image, ImageData, loadImage } from 'canvas';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

faceapi.env.monkeyPatch({
  Canvas: Canvas as unknown as typeof HTMLCanvasElement,
  Image: Image as unknown as typeof HTMLImageElement,
  ImageData: ImageData as unknown as typeof globalThis.ImageData
});

export type FaceCompareResult = {
  matched: boolean;
  name: string | null;
  distance: number | null;
  threshold: number;
};

type CachedDescriptor = {
  descriptor: Float32Array | null;
  mtimeMs: number;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendRoot = path.resolve(__dirname, '../..');
const storagePath = process.env.STORAGE_PATH
  ? path.resolve(process.env.STORAGE_PATH)
  : path.join(backendRoot, 'src/storage');
const facesPath = path.join(storagePath, 'faces');
const modelsPath = path.join(storagePath, 'models');
const wasmPath = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm'));
const threshold = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.6);
const detectorOptions = new faceapi.TinyFaceDetectorOptions({
  inputSize: 160,
  scoreThreshold: 0.3
});

let modelsLoaded = false;
const descriptorCache = new Map<string, CachedDescriptor>();

async function loadModels() {
  if (modelsLoaded) return;

  setWasmPaths(pathToFileURL(`${wasmPath}${path.sep}`).href);
  await tf.setBackend('wasm');
  await tf.ready();

  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsPath);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);

  modelsLoaded = true;
}

async function getDescriptorFromImage(input: string | Buffer) {
  await loadModels();

  const image = await loadImage(input);
  const detection = await faceapi
    .detectSingleFace(image as unknown as faceapi.TNetInput, detectorOptions)
    .withFaceLandmarks()
    .withFaceDescriptor();

  return detection?.descriptor ?? null;
}

async function getDescriptorFromFile(filePath: string) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;

  const cached = descriptorCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.descriptor;
  }

  const descriptor = await getDescriptorFromImage(filePath);
  descriptorCache.set(filePath, { descriptor, mtimeMs: stat.mtimeMs });
  return descriptor;
}

function dataUrlToBuffer(dataUrl: string) {
  const [, base64 = ''] = dataUrl.split(',');
  return Buffer.from(base64, 'base64');
}

export async function compareFaceWithDataset(cardFaceDataUrl: string): Promise<FaceCompareResult> {
  const queryDescriptor = await getDescriptorFromImage(dataUrlToBuffer(cardFaceDataUrl));
  if (!queryDescriptor) {
    return { matched: false, name: null, distance: null, threshold };
  }

  const files = await fs.readdir(facesPath).catch(() => []);
  const imageFiles = files.filter((file) => /\.(jpe?g|png|webp)$/i.test(file));

  let best: { name: string; distance: number } | null = null;

  for (const file of imageFiles) {
    const descriptor = await getDescriptorFromFile(path.join(facesPath, file));
    if (!descriptor) continue;

    const distance = faceapi.euclideanDistance(queryDescriptor, descriptor);
    if (!best || distance < best.distance) {
      best = { name: path.parse(file).name, distance };
    }
  }

  return {
    matched: Boolean(best && best.distance <= threshold),
    name: best?.name ?? null,
    distance: best?.distance ?? null,
    threshold
  };
}
