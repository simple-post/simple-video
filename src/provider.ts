import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import sharp from "sharp";
import type { AssetPlan, Spec } from "./spec.js";
import { hash, safeError } from "./io.js";

export type Generated = { bytes: Buffer; requestId?: string; usage?: unknown };
export interface ImageProvider {
  name: string;
  identity: string;
  paid: boolean;
  generate(
    asset: AssetPlan,
    spec: Spec,
    saveResponse: (body: string) => Promise<void>,
    reference?: Buffer,
  ): Promise<Generated>;
}
export class ProviderError extends Error {
  constructor(
    message: string,
    public uncertain: boolean,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function loadEnv(file?: string) {
  if (!file) return;
  const values = parse(await readFile(file));
  for (const key of [
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "FAL_KEY",
    "SIMPLE_VIDEO_HOME",
    "SIMPLE_VIDEO_DEPTHFLOW",
  ]) {
    if (values[key] && !process.env[key]) process.env[key] = values[key];
  }
}
export function decodeResponse(body: string, requestId?: string): Generated {
  const json = JSON.parse(body) as {
    data?: { b64_json?: string }[];
    usage?: unknown;
  };
  const data = json.data?.[0]?.b64_json;
  if (!data)
    throw new ProviderError(
      "Image response has no base64 image; saved response can be inspected locally",
      true,
      requestId,
    );
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length)
    throw new ProviderError("Empty image response", true, requestId);
  return { bytes, requestId, usage: json.usage };
}
export class OpenAIImages implements ImageProvider {
  name = "openai";
  identity = "openai-images-v1";
  paid = true;
  constructor(private fetcher: typeof fetch = fetch) {}
  async generate(
    asset: AssetPlan,
    spec: Spec,
    saveResponse: (body: string) => Promise<void>,
    reference?: Buffer,
  ): Promise<Generated> {
    const key = process.env.OPENAI_API_KEY;
    if (!key)
      throw new ProviderError(
        "OpenAI API key is missing; run simple-video auth login, or use --env-file / OPENAI_API_KEY",
        false,
      );
    const parameters = {
      model: spec.image.model,
      prompt: asset.prompt,
      size: asset.size,
      quality: spec.image.quality,
      n: 1,
      output_format: "png",
    };
    let requestBody: string | FormData = JSON.stringify(parameters);
    if (reference) {
      const form = new FormData();
      for (const [key, value] of Object.entries(parameters))
        form.set(key, String(value));
      form.set(
        "image[]",
        new Blob([new Uint8Array(reference)], { type: "image/png" }),
        "previous-slide.png",
      );
      requestBody = form;
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.openai.com/v1/images/${reference ? "edits" : "generations"}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            ...(reference ? {} : { "Content-Type": "application/json" }),
          },
          body: requestBody,
          signal: AbortSignal.timeout(300_000),
        },
      );
    } catch (e) {
      throw new ProviderError(
        `Image request outcome is uncertain: ${safeError(e)}. No automatic paid retry.`,
        true,
      );
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new ProviderError(
        "Response interrupted; request outcome is uncertain",
        true,
        requestId,
      );
    }
    if (!response.ok) {
      const detail = (() => {
        try {
          return JSON.parse(body).error?.message;
        } catch {
          return undefined;
        }
      })();
      // A provider 5xx may follow completed work. Only explicit 4xx rejections are safe to retry.
      throw new ProviderError(
        `OpenAI HTTP ${response.status}: ${safeError(detail ?? "request rejected")}`,
        response.status >= 500,
        requestId,
      );
    }
    await saveResponse(body);
    return decodeResponse(body, requestId);
  }
}
export class FixtureImages implements ImageProvider {
  name = "fixture";
  identity = "fixture-v1";
  paid = false;
  async generate(asset: AssetPlan): Promise<Generated> {
    const [width, height] = asset.size.split("x").map(Number) as [
      number,
      number,
    ];
    const hue = [...asset.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="hsl(${hue},40%,30%)"/><circle cx="50%" cy="42%" r="200" fill="hsl(${hue},60%,60%)"/><path d="M0 ${height} L${width / 2} ${height / 2} L${width} ${height} Z" fill="#183321"/></svg>`;
    return {
      bytes: await sharp(Buffer.from(svg)).png().toBuffer(),
      usage: { fixture: true },
    };
  }
}

export class LocalImages implements ImageProvider {
  name = "local";
  paid = false;
  identity: string;
  private constructor(private images: Record<string, Buffer>) {
    this.identity =
      "local-v1-" +
      hash(
        JSON.stringify(
          Object.entries(images).map(([id, bytes]) => [id, hash(bytes)]),
        ),
      );
  }
  static async fromSpec(spec: Spec, assetIds: string[]) {
    const images: Record<string, Buffer> = {};
    for (const id of assetIds) {
      const file = spec.image.files?.[id];
      if (!file)
        throw Error(
          `Missing image.files[${JSON.stringify(id)}]; use plan to list all asset IDs`,
        );
      const bytes = await readFile(file);
      await sharp(bytes).metadata();
      images[id] = bytes;
    }
    return new LocalImages(images);
  }
  async generate(asset: AssetPlan): Promise<Generated> {
    const bytes = this.images[asset.id];
    if (!bytes) throw Error(`Local asset ${asset.id} is missing`);
    return { bytes };
  }
}
