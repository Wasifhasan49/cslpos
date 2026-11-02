/**
 * The shop's logo, for the top of every printout.
 *
 * It is kept as a data URL in the shop's settings rather than as a file in object
 * storage. A logo is one small image per shop that changes about once; a storage bucket
 * would mean another thing to create, another set of access rules to get right, and a
 * public URL to leak. A few tens of kilobytes of base64 in a text column is the whole
 * feature, and it works in demo mode too.
 *
 * Which means the size matters, so whatever is picked is scaled down to something a
 * letterhead can use before it is stored.
 */

/** As big as a printed letterhead can use: about 45 mm wide at 300 dpi. */
export const LOGO_MAX_W = 520;
export const LOGO_MAX_H = 240;
/** Past this, something has gone wrong — a photograph, not a logo. */
export const LOGO_MAX_BYTES = 120_000;

/** The size to draw at: inside the box, keeping the shape, never enlarged. */
export function fitWithin(w: number, h: number, maxW = LOGO_MAX_W, maxH = LOGO_MAX_H) {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  const scale = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** What a picked file cannot be, in words the screen can show as they are. */
export class BadLogo extends Error {}

/**
 * Turn a picked file into a data URL small enough to keep in the settings.
 *
 * An SVG is kept as it is — it is already small and scales better than anything a
 * canvas would produce. Everything else is drawn into a canvas at letterhead size and
 * comes out as PNG, which keeps a logo's flat colours and its transparent background.
 */
export async function logoDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new BadLogo("That is not an image. Pick a PNG, JPG or SVG of the shop's logo.");
  }

  if (file.type === "image/svg+xml") {
    if (file.size > LOGO_MAX_BYTES) {
      throw new BadLogo("That drawing is too big to keep in the settings. Save it as a PNG instead.");
    }
    return await readAsDataUrl(file);
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new BadLogo("That image could not be read. Pick a PNG or a JPG.");
  });
  const { w, h } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new BadLogo("This browser could not resize that image.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const url = canvas.toDataURL("image/png");
  if (url.length > LOGO_MAX_BYTES * 1.4) {
    throw new BadLogo(
      "That image has too much detail for a letterhead. A plain logo on a white or "
      + "transparent background works best.",
    );
  }
  return url;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new BadLogo("That file could not be read."));
    reader.readAsDataURL(file);
  });
}
