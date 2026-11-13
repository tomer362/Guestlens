import type { StorageProvider } from "./provider";
import { vercelBlob } from "./vercel-blob";

export function storage(): StorageProvider {
  switch (process.env.STORAGE_PROVIDER ?? "vercel-blob") {
    default:
      return vercelBlob;
  }
}
