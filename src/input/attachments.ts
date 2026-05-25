import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Attachment } from '../types.js';

const IMAGE_PATTERN = /(?:@image:|@)(\S+\.(?:png|jpe?g|webp|gif|bmp|tiff)|https?:\/\/\S+)/gi;
const maxLocalImageBytes = Math.floor((5 * 1024 * 1024 * 3) / 4);

export function extractImageAttachments(input: string): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const text = input.replace(IMAGE_PATTERN, (_match, imagePath: string) => {
    const attachment = buildImageAttachment(imagePath);
    attachments.push({
      type: 'image',
      path: attachment.path,
      mimeType: attachment.mimeType
    });
    return '';
  }).trim();

  return { text: text || input.trim(), attachments };
}

function buildImageAttachment(imagePath: string): Attachment {
  if (/^https?:\/\//i.test(imagePath)) {
    return {
      type: 'image',
      path: imagePath,
      mimeType: mimeTypeForPath(imagePath)
    };
  }

  const absolutePath = path.resolve(imagePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`图片文件不存在：${imagePath}`);
  }
  const fileStat = statSync(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`图片路径不是文件：${imagePath}`);
  }
  if (fileStat.size > maxLocalImageBytes) {
    throw new Error(`图片文件过大：${formatBytes(fileStat.size)}，最大支持 ${formatBytes(maxLocalImageBytes)}。`);
  }
  const header = readFileSync(absolutePath, { encoding: null, flag: 'r' }).subarray(0, 512);
  const detectedMime = mimeTypeFromBuffer(header);
  if (!detectedMime) {
    throw new Error(`文件不是支持的图片格式：${imagePath}`);
  }
  return {
    type: 'image',
    path: imagePath,
    mimeType: detectedMime
  };
}

function mimeTypeForPath(filePath: string): string {
  const pathname = /^https?:\/\//i.test(filePath) ? new URL(filePath).pathname : filePath;
  const ext = path.extname(pathname).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tiff') return 'image/tiff';
  return 'image/png';
}

function mimeTypeFromBuffer(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') {
    return 'image/bmp';
  }
  if (buffer.length >= 4) {
    const magic = buffer.subarray(0, 4).toString('ascii');
    if (magic === 'II*\x00' || magic === 'MM\x00*') return 'image/tiff';
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
