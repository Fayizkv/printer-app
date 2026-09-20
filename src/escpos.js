export const PAPER_PRESETS = [
  { id: '32', label: '32 mm', paperMm: 32, printableMm: 30, dpi: 203, dots: 240 },
  { id: '48', label: '48 mm', paperMm: 48, printableMm: 48, dpi: 203, dots: 384 },
  { id: '58', label: '58 mm', paperMm: 58, printableMm: 48, dpi: 203, dots: 384 },
  { id: '80', label: '80 mm', paperMm: 80, printableMm: 72, dpi: 203, dots: 576 },
];

export const SIZE_STORAGE_KEY = 'thermal-printer-size';
export const DEFAULT_PRINTER_SIZE = { ...PAPER_PRESETS[2], id: '58' };

export function normalizeDots(value) {
  const dots = Math.max(64, Math.min(1024, Math.round(Number(value) || 384)));
  return dots - (dots % 8);
}

export function dotsFromMm(mm, dpi = 203) {
  return normalizeDots((Number(mm) * Number(dpi)) / 25.4);
}

export function mmFromDots(dots, dpi = 203) {
  return Math.round(((Number(dots) * 25.4) / Number(dpi)) * 10) / 10;
}

export function loadPrinterSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_STORAGE_KEY) || 'null');
    if (!saved) return { ...DEFAULT_PRINTER_SIZE };
    return {
      id: saved.id || 'custom',
      paperMm: Number(saved.paperMm) || DEFAULT_PRINTER_SIZE.paperMm,
      printableMm: Number(saved.printableMm) || DEFAULT_PRINTER_SIZE.printableMm,
      dpi: Number(saved.dpi) === 300 ? 300 : 203,
      dots: normalizeDots(saved.dots || DEFAULT_PRINTER_SIZE.dots),
    };
  } catch {
    return { ...DEFAULT_PRINTER_SIZE };
  }
}

export function savePrinterSize(size) {
  try {
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function buildInit() {
  return Uint8Array.from([0x1b, 0x40]);
}

export function buildFeedAndCut() {
  return Uint8Array.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x41, 0x10]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkSizeFor(characteristic) {
  const uuid = String(characteristic.uuid || '').replace(/-/g, '').toLowerCase();
  if (uuid.includes('ffe1')) return 20;
  return 128;
}

export async function writeInChunks(characteristic, bytes, { onProgress, chunkSize } = {}) {
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let size = chunkSize || chunkSizeFor(characteristic);
  const useAck = Boolean(characteristic.properties.write);
  const write = useAck
    ? (chunk) => characteristic.writeValue(chunk)
    : (chunk) => characteristic.writeValueWithoutResponse(chunk);
  const gap = useAck ? 24 : 70;

  for (let offset = 0; offset < payload.length; ) {
    let attempts = 0;
    while (true) {
      const chunk = new Uint8Array(payload.subarray(offset, offset + size));
      try {
        await write(chunk);
        offset += chunk.length;
        onProgress?.(offset, payload.length);
        await sleep(gap);
        break;
      } catch (error) {
        attempts += 1;
        if (size > 20) {
          size = 20;
          continue;
        }
        if (attempts > 8) throw error;
        await sleep(90 * attempts);
      }
    }
  }
}

function rasterCommand(widthBytes, height, data) {
  const header = Uint8Array.from([
    0x1d,
    0x76,
    0x30,
    0x00,
    widthBytes & 0xff,
    (widthBytes >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
  ]);
  return concatBytes(header, data);
}

export function rasterBands(canvas, bandHeight = 40) {
  const { raster, widthBytes, height } = canvasToRaster(canvas);
  const bands = [];
  for (let y = 0; y < height; y += bandHeight) {
    const sliceHeight = Math.min(bandHeight, height - y);
    const slice = raster.slice(y * widthBytes, (y + sliceHeight) * widthBytes);
    bands.push(rasterCommand(widthBytes, sliceHeight, slice));
  }
  return bands;
}

export async function printCanvas(characteristic, canvas, { onProgress } = {}) {
  const bands = rasterBands(canvas, 40);
  const total = bands.reduce((sum, band) => sum + band.length, 0) + 11;
  let sent = 0;

  await writeInChunks(characteristic, buildInit());
  sent += 2;
  onProgress?.(sent, total);
  await sleep(80);

  for (const band of bands) {
    await writeInChunks(characteristic, band, {
      onProgress: (part) => onProgress?.(sent + part, total),
    });
    sent += band.length;
    await sleep(160);
  }

  await writeInChunks(characteristic, buildFeedAndCut());
  onProgress?.(total, total);
}

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        if (img.decode) await img.decode();
      } catch {
        // Some browsers decode during drawImage instead.
      }
      resolve(img);
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });
}

export async function loadImageElement(source) {
  const blob = source instanceof Blob ? source : null;

  if (blob && typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(blob);
      } catch {
        // Fall through to Image().
      }
    }
  }

  if (blob) {
    const url = URL.createObjectURL(blob);
    try {
      return await decodeImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return decodeImage(source);
}

function wrapCanvasLines(ctx, text, maxWidth) {
  const paragraphs = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let current = '';

    const pushLongToken = (token) => {
      let chunk = '';
      for (const char of token) {
        const next = chunk + char;
        if (ctx.measureText(next).width <= maxWidth) {
          chunk = next;
        } else {
          if (chunk) lines.push(chunk);
          chunk = char;
        }
      }
      return chunk;
    };

    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) {
        current = test;
        continue;
      }
      if (current) lines.push(current);
      current = ctx.measureText(word).width > maxWidth ? pushLongToken(word) : word;
    }

    if (current) lines.push(current);
  }

  return lines;
}

export function renderTextCanvas(text, widthDots) {
  const width = normalizeDots(widthDots);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const padding = Math.max(4, Math.round(width / 48));
  const fontSize = Math.max(16, Math.round(width / 16));
  const lineHeight = Math.round(fontSize * 1.28);

  ctx.font = `600 ${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif`;
  const lines = wrapCanvasLines(ctx, text.trim() ? text : ' ', width - padding * 2);
  const height = Math.max(lineHeight + padding * 2, lines.length * lineHeight + padding * 2);

  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = `600 ${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textBaseline = 'top';

  lines.forEach((line, index) => {
    ctx.fillText(line, padding, padding + index * lineHeight);
  });

  return canvas;
}

export function drawImageToCanvas(image, widthDots) {
  const width = normalizeDots(widthDots);
  const ratio = image.height / image.width;
  const height = Math.max(1, Math.round(width * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.min(height, 3600);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function ditherCanvas(canvas, invert = false) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const gray = new Float32Array(width * height);

  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    const value = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    gray[i] = invert ? 255 - value : value;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const oldPixel = gray[index];
      const newPixel = oldPixel < 128 ? 0 : 255;
      const error = oldPixel - newPixel;
      gray[index] = newPixel;
      if (x + 1 < width) gray[index + 1] += error * (7 / 16);
      if (y + 1 < height) {
        if (x > 0) gray[index + width - 1] += error * (3 / 16);
        gray[index + width] += error * (5 / 16);
        if (x + 1 < width) gray[index + width + 1] += error * (1 / 16);
      }
    }
  }

  for (let i = 0; i < width * height; i += 1) {
    const tone = gray[i] < 128 ? 0 : 255;
    const offset = i * 4;
    data[offset] = tone;
    data[offset + 1] = tone;
    data[offset + 2] = tone;
    data[offset + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function canvasToRaster(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height).data;
  const widthBytes = Math.ceil(width / 8);
  const raster = new Uint8Array(widthBytes * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = imageData[(y * width + x) * 4];
      if (pixel < 128) {
        raster[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return { raster, widthBytes, height };
}

export function canvasToPreviewUrl(canvas) {
  return canvas.toDataURL('image/png');
}
