import path from 'node:path';
import type { Attachment } from '../types.js';

const IMAGE_PATTERN = /(?:@image:|@)(\S+\.(?:png|jpe?g|webp|gif|bmp|tiff)|https?:\/\/\S+)/gi;

export function extractImageAttachments(input: string): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const text = input.replace(IMAGE_PATTERN, (_match, imagePath: string) => {
    attachments.push({
      type: 'image',
      path: imagePath,
      mimeType: mimeTypeForPath(imagePath)
    });
    return '';
  }).trim();

  return { text: text || input.trim(), attachments };
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tiff') return 'image/tiff';
  return 'image/png';
}
