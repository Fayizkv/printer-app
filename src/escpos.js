export const PAPER_PRESETS = [
  { id: '58', label: '58 mm', dots: 384 },
  { id: '80', label: '80 mm', dots: 576 },
];

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

export async function writeInChunks(characteristic, bytes) {
  const chunkSize = 180;
  const write = characteristic.properties.writeWithoutResponse
    ? characteristic.writeValueWithoutResponse.bind(characteristic)
    : characteristic.writeValue.bind(characteristic);

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await write(bytes.slice(offset, offset + chunkSize));
    if (offset + chunkSize < bytes.length) {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }
}

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });
}

export async function loadImageElement(source) {
  if (source instanceof Blob) {
    const url = URL.createObjectURL(source);
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
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const padding = 8;
  const fontSize = widthDots >= 576 ? 28 : 24;
  const lineHeight = Math.round(fontSize * 1.28);

  ctx.font = `600 ${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif`;
  const lines = wrapCanvasLines(ctx, text.trim() ? text : ' ', widthDots - padding * 2);
  const height = Math.max(lineHeight + padding * 2, lines.length * lineHeight + padding * 2);

  canvas.width = widthDots;
  canvas.height = height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthDots, height);
  ctx.fillStyle = '#000000';
  ctx.font = `600 ${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textBaseline = 'top';

  lines.forEach((line, index) => {
    ctx.fillText(line, padding, padding + index * lineHeight);
  });

  return canvas;
}

export function drawImageToCanvas(image, widthDots) {
  const ratio = image.height / image.width;
  const height = Math.max(1, Math.round(widthDots * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = Math.min(height, 2400);
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

export function buildRasterJob(canvas) {
  const { raster, widthBytes, height } = canvasToRaster(canvas);
  const bandHeight = 200;
  const bands = [buildInit()];

  for (let y = 0; y < height; y += bandHeight) {
    const sliceHeight = Math.min(bandHeight, height - y);
    const slice = raster.subarray(y * widthBytes, (y + sliceHeight) * widthBytes);
    bands.push(rasterCommand(widthBytes, sliceHeight, slice));
  }

  bands.push(buildFeedAndCut());
  return concatBytes(...bands);
}

export function canvasToPreviewUrl(canvas) {
  return canvas.toDataURL('image/png');
}
