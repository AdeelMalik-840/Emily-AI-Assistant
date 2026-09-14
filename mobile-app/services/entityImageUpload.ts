import { File as ExpoFile } from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { auth, storage } from "@/firebase";
import { ENTITY_IMAGE_LIMITS } from "@/lib/entityImageConfig";

/**
 * Image uploads: **only** `pickAndUploadEntityImages` is a public entry point.
 * `uploadImageToFirebaseStorage` is internal (do not import elsewhere).
 */

const UPLOAD_IMAGE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Picker: lower = smaller temp file, faster handoff to compress / upload. */
const IMAGE_PICKER_QUALITY = 0.65;

/** Max long edge after resize — catalog / WhatsApp friendly. */
const UPLOAD_MAX_EDGE_PX = 1200;

/** JPEG output quality (0–1) for expo-image-manipulator. */
const JPEG_COMPRESS_QUALITY = 0.7;

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

function firebaseStorageMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case "storage/unauthorized":
      return "Upload denied. Sign in again or ask your admin to allow Storage uploads for your account.";
    case "storage/canceled":
      return "Upload was canceled.";
    case "storage/retry-limit-exceeded":
      return "Network error while uploading. Try again.";
    case "storage/invalid-checksum":
      return "Image file was corrupted. Try another photo.";
    default:
      return fallback;
  }
}

function normalizeContentType(mime: string | undefined, uri: string): string {
  const m = mime?.trim().toLowerCase();
  if (m && m.startsWith("image/")) {
    return m === "image/jpg" ? "image/jpeg" : m;
  }
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  return "image/jpeg";
}

function assertAllowedImageType(contentType: string): void {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base.startsWith("image/")) {
    throw new Error("Only image files are allowed.");
  }
  if (!ALLOWED_IMAGE_MIME.has(base)) {
    throw new Error(`Unsupported image type (${base}). Use JPEG, PNG, GIF, or WebP.`);
  }
}

/**
 * Always re-encode to JPEG at `JPEG_COMPRESS_QUALITY`.
 * If long edge exceeds `UPLOAD_MAX_EDGE_PX`, scale that edge down (unknown dimensions → width cap).
 */
async function compressImageForUpload(
  uri: string,
  width?: number,
  height?: number
): Promise<string> {
  const w = width ?? 0;
  const h = height ?? 0;
  const actions: ImageManipulator.Action[] = [];

  if (!w || !h) {
    actions.push({ resize: { width: UPLOAD_MAX_EDGE_PX } });
  } else {
    const longEdge = Math.max(w, h);
    if (longEdge > UPLOAD_MAX_EDGE_PX) {
      if (w >= h) {
        actions.push({ resize: { width: UPLOAD_MAX_EDGE_PX } });
      } else {
        actions.push({ resize: { height: UPLOAD_MAX_EDGE_PX } });
      }
    }
  }

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: JPEG_COMPRESS_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return result.uri;
}

/** Byte size of a local file URI when available (native file system). */
function tryGetLocalFileByteSize(uri: string): number | undefined {
  try {
    const f = new ExpoFile(uri);
    const meta = f.info();
    if (meta.exists && meta.size != null && meta.size >= 0) {
      return meta.size;
    }
  } catch {
    /* optional */
  }
  return undefined;
}

/**
 * Native (Expo + Hermes): read bytes only via expo-file-system — no fetch/blob/arrayBuffer on RN.
 */
async function readUriAsUint8ArrayNative(uri: string): Promise<Uint8Array> {
  const file = new ExpoFile(uri);
  return file.bytes();
}

/**
 * Web only: read picked / remote URI for SDK upload path.
 */
async function readUriAsUint8ArrayWeb(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Could not read image (${response.status}).`);
  }
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Hermes-safe upload: Firebase JS `uploadBytes` internally does `multipartUpload` → `new Blob([Uint8Array,...])`,
 * which throws "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported".
 * Use Storage REST `uploadType=media` + XHR body = raw bytes (no Blob).
 */
/**
 * Raw XHR + default `responseType` (text). RN converts `Uint8Array` body via `binaryToBase64`
 * (`convertRequestBody`) — it does **not** use `new Blob([typedArray])` (which BlobManager rejects).
 */
function xhrPostBytes(
  url: string,
  headerMap: Record<string, string>,
  body: Uint8Array
): Promise<{ status: number; responseText: string }> {
  const payload =
    body.byteOffset === 0 && body.byteLength === body.buffer.byteLength
      ? body
      : new Uint8Array(body);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    for (const [k, v] of Object.entries(headerMap)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.onload = () => {
      resolve({ status: xhr.status, responseText: xhr.responseText ?? "" });
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.timeout = 120_000;
    xhr.send(payload);
  });
}

type GcsInsertResponse = {
  name?: string;
  bucket?: string;
  downloadTokens?: string;
  error?: { code?: number; message?: string; status?: string };
};

/** Match bucket string used in Storage URLs (strip gs:// and any path). */
function normalizeStorageBucketId(bucket: string): string {
  let b = bucket.trim();
  if (b.toLowerCase().startsWith("gs://")) {
    b = b.slice(5);
  }
  const slash = b.indexOf("/");
  if (slash !== -1) {
    b = b.slice(0, slash);
  }
  return b;
}

/**
 * Same query encoding as @firebase/storage `makeQueryString` (keys and values encoded).
 */
function storageRestQueryString(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
    );
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function buildDownloadUrlFromRestResponse(
  bucket: string,
  objectPath: string,
  json: GcsInsertResponse
): string | null {
  const raw =
    typeof json.downloadTokens === "string" ? json.downloadTokens.trim() : "";
  const token = raw.split(",")[0]?.trim();
  if (!token) return null;
  const encodedPath = encodeURIComponent(objectPath);
  const b = encodeURIComponent(bucket);
  return `https://firebasestorage.googleapis.com/v0/b/${b}/o/${encodedPath}?alt=media&token=${encodeURIComponent(token)}`;
}

async function uploadBytesFirebaseStorageRestNative(
  objectPath: string,
  data: Uint8Array,
  contentType: string
): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Sign in to upload images.");
  }

  const storageRef = ref(storage, objectPath);
  const bucketRaw = storageRef.bucket;
  if (!bucketRaw || typeof bucketRaw !== "string") {
    throw new Error("Firebase storageBucket is not configured.");
  }
  const bucket = normalizeStorageBucketId(bucketRaw);

  const idToken = await user.getIdToken(false);
  if (!idToken) {
    throw new Error("Could not get ID token. Sign in again.");
  }

  /**
   * @firebase/storage sends `Authorization: Firebase <idToken>` (not Bearer) on this API.
   * Matches multipart/simple requests to firebasestorage.googleapis.com.
   */
  const authHeaderValue = `Firebase ${idToken}`;

  const pathSegment = encodeURIComponent(bucket);
  const query = storageRestQueryString({
    uploadType: "media",
    name: objectPath,
  });
  const url = `https://firebasestorage.googleapis.com/v0/b/${pathSegment}/o${query}`;

  const appId =
    storage.app && "options" in storage.app && storage.app.options
      ? String((storage.app.options as { appId?: string }).appId ?? "")
      : "";

  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[entityImageUpload] REST upload request", {
      method: "POST",
      url,
      bucketResolved: bucket,
      objectPath,
      bodyBytes: data.byteLength,
      contentType,
      headers: {
        Authorization: `Firebase <idToken len=${idToken.length}>`,
        "Content-Type": contentType,
        ...(appId ? { "X-Firebase-GMPID": appId } : {}),
      },
    });
  }

  const headerMap: Record<string, string> = {
    Authorization: authHeaderValue,
    "Content-Type": contentType,
  };
  if (appId) {
    headerMap["X-Firebase-GMPID"] = appId;
    headerMap["X-Firebase-Storage-Version"] = "webjs/rest-xhr";
  }

  const { status, responseText } = await xhrPostBytes(url, headerMap, data);

  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[entityImageUpload] REST upload response", {
      status,
      responseBody: responseText,
      responseBodyLength: responseText.length,
    });
  }

  let parsed: GcsInsertResponse = {};
  try {
    parsed = responseText ? (JSON.parse(responseText) as GcsInsertResponse) : {};
  } catch {
    /* non-JSON body */
  }

  if (status < 200 || status >= 300) {
    const msg =
      parsed.error?.message ??
      responseText?.slice(0, 200) ??
      `Upload failed (HTTP ${status}).`;
    if (status === 401 || status === 403) {
      throw new Error(firebaseStorageMessage("storage/unauthorized", msg));
    }
    if (status === 404) {
      throw new Error(
        `${msg} If this is "Not Found", confirm EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET matches ` +
          `Firebase Console → Storage (bucket id is often project.appspot.com or project.firebasestorage.app). ` +
          `Resolved bucket for this upload: ${bucket}`
      );
    }
    throw new Error(msg);
  }

  const direct = buildDownloadUrlFromRestResponse(bucket, objectPath, parsed);
  if (direct) return direct;

  return getDownloadURL(storageRef);
}

type UploadImageToFirebaseParams = {
  uri: string;
  /** Storage object path, e.g. `businesses/{uid}/catalogItems/{id}/file.jpg` */
  storagePath: string;
  /** From ImagePicker `asset.mimeType` or similar */
  contentType?: string;
  /** When set (e.g. `ImagePickerAsset.fileSize`), used for an early size check */
  knownByteSize?: number;
  maxBytes?: number;
};

/**
 * Final upload implementation (internal). iOS/Android: REST+XHR; web: SDK `uploadBytes`.
 */
async function uploadImageToFirebaseStorage(
  params: UploadImageToFirebaseParams
): Promise<string> {
  const maxBytes = params.maxBytes ?? UPLOAD_IMAGE_DEFAULT_MAX_BYTES;
  const contentType = normalizeContentType(params.contentType, params.uri);
  assertAllowedImageType(contentType);

  if (params.knownByteSize != null && params.knownByteSize > maxBytes) {
    throw new Error(
      `Image is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB).`
    );
  }

  if (params.knownByteSize == null && Platform.OS !== "web") {
    try {
      const f = new ExpoFile(params.uri);
      const meta = f.info();
      if (meta.exists && meta.size != null && meta.size > maxBytes) {
        throw new Error(
          `Image is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB).`
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("too large")) throw e;
    }
  }

  let data: Uint8Array;
  try {
    data =
      Platform.OS === "web"
        ? await readUriAsUint8ArrayWeb(params.uri)
        : await readUriAsUint8ArrayNative(params.uri);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Could not read image.";
    throw new Error(msg);
  }

  if (data.byteLength === 0) {
    throw new Error("Image file is empty.");
  }
  if (data.byteLength > maxBytes) {
    throw new Error(
      `Image is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB).`
    );
  }

  const transport =
    Platform.OS === "web" ? "firebase-web-uploadBytes" : "firebase-rest-xhr";
  console.log("[entityImageUpload] uploadImageToFirebaseStorage (final)", {
    platform: Platform.OS,
    transport,
    storagePath: params.storagePath,
    byteLength: data.byteLength,
    contentType,
  });

  try {
    if (Platform.OS === "web") {
      const storageRef = ref(storage, params.storagePath);
      await uploadBytes(storageRef, data, { contentType });
      return await getDownloadURL(storageRef);
    }
    return await uploadBytesFirebaseStorageRestNative(
      params.storagePath,
      data,
      contentType
    );
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const code = typeof err.code === "string" ? err.code : undefined;
    const msg =
      typeof err.message === "string" && err.message.trim() !== ""
        ? err.message
        : "Upload failed.";
    throw new Error(firebaseStorageMessage(code, msg));
  }
}

/**
 * **Sole public upload entry point** — opens the library and uploads for catalog items.
 */
export async function pickAndUploadEntityImages(params: {
  userId: string;
  itemId: string;
  currentUrls: string[];
}): Promise<string[]> {
  const { userId, itemId, currentUrls } = params;
  const maxTotal = ENTITY_IMAGE_LIMITS.maxPerItem;
  const remaining = maxTotal - currentUrls.length;
  if (remaining <= 0) return [];

  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error("Allow photo library access to add images.");
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: remaining,
    quality: IMAGE_PICKER_QUALITY,
  });

  if (result.canceled || !result.assets?.length) return [];

  const assets = result.assets.slice(
    0,
    Math.min(result.assets.length, remaining)
  );

  const uploadOne = async (
    asset: ImagePickerAsset,
    idx: number
  ): Promise<string> => {
    const slug = `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 10)}`;
    const objectPath = `businesses/${userId}/catalogItems/${itemId}/${slug}.jpg`;

    const compressedUri = await compressImageForUpload(
      asset.uri,
      asset.width,
      asset.height
    );
    const compressedSize = tryGetLocalFileByteSize(compressedUri);

    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.log("[imageCompression]", {
        originalBytes: asset.fileSize,
        compressedUri,
        compressedBytes: compressedSize,
      });
    }

    return uploadImageToFirebaseStorage({
      uri: compressedUri,
      storagePath: objectPath,
      contentType: "image/jpeg",
      knownByteSize: compressedSize,
    });
  };

  return Promise.all(assets.map((asset, idx) => uploadOne(asset, idx)));
}
