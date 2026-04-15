import { v2 as cloudinary } from "cloudinary";
import { env } from "./env";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

interface UploadResult {
  publicId: string;
  secureUrl: string;
  width: number;
  height: number;
  format: string;
}

export async function uploadImage(
  filePath: string,
  folder: string
): Promise<UploadResult> {
  const result = await cloudinary.uploader.upload(filePath, {
    folder: `chefless/${folder}`,
    resource_type: "image",
    transformation: [
      { quality: "auto", fetch_format: "auto" },
    ],
  });

  return {
    publicId: result.public_id,
    secureUrl: result.secure_url,
    width: result.width,
    height: result.height,
    format: result.format,
  };
}

export function getImageUrl(
  publicId: string,
  options: { width?: number; height?: number; crop?: string } = {}
): string {
  return cloudinary.url(publicId, {
    secure: true,
    width: options.width,
    height: options.height,
    crop: options.crop ?? "fill",
    quality: "auto",
    fetch_format: "auto",
  });
}

export async function deleteImage(publicId: string): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Cloudinary delete failed for ${publicId}: ${msg}`);
  }
}

/**
 * Extract the Cloudinary public ID from a secure URL.
 * e.g. "https://res.cloudinary.com/xxx/image/upload/v123/chefless/shopping/abc.jpg"
 *   → "chefless/shopping/abc"
 */
export function publicIdFromUrl(url: string): string | null {
  const match = url.match(/\/upload\/(?:v\d+\/)?(chefless\/.+?)(?:\.\w+)?$/);
  return match ? match[1] : null;
}

export { cloudinary };
