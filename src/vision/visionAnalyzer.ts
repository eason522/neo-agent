import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import type { Logger } from '../logging/logger.js';
import { isAbortError, throwIfAborted } from '../utils/abort.js';

const VISUAL_PRIMITIVE_PROMPT = `You are a visual perception module for a text-only reasoning agent.
Convert each image into compact visual primitives for downstream reasoning.

Return structured Markdown with:
1. OCR/text exactly as visible when useful.
2. Objects, people, UI elements, charts, tables, diagrams, and code-like content.
3. Spatial relationships, hierarchy, ordering, coordinates when they matter.
4. Attributes: colors, sizes, states, labels, affordances, counts.
5. Task-relevant inferences separated from direct observations.
6. Ambiguities or low-confidence regions.

Do not solve the user's whole task. Produce perception context only.`;

export class VisionAnalyzer {
  constructor(private readonly models: ModelRegistry, private readonly logger?: Logger) {}

  async analyze(attachments: Attachment[], userPrompt: string, signal?: AbortSignal): Promise<string | undefined> {
    if (attachments.length === 0) return undefined;
    const start = Date.now();
    this.logger?.info('vision.analyze.start', {
      attachmentCount: attachments.length,
      promptChars: userPrompt.length
    });
    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: `${VISUAL_PRIMITIVE_PROMPT}\n\nUser task:\n${userPrompt}`
      }
    ];

    try {
      for (const attachment of attachments) {
        throwIfAborted(signal);
        const image = await toDataUrl(attachment, signal);
        this.logger?.info('vision.attachment.prepared', {
          mimeType: attachment.mimeType,
          local: image.local,
          bytes: image.bytes,
          dataUrlChars: image.url.length
        });
        content.push({
          type: 'image_url',
          image_url: {
            url: image.url,
            detail: 'low'
          }
        });
      }

      throwIfAborted(signal);
      const result = await this.models.vision.chat({
        messages: [
          {
            role: 'user',
            content
          }
        ],
        signal
      });
      this.logger?.info('vision.analyze.success', {
        attachmentCount: attachments.length,
        outputChars: result.length,
        durationMs: Date.now() - start
      });
      return result;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        this.logger?.info('vision.analyze.cancelled', {
          attachmentCount: attachments.length,
          durationMs: Date.now() - start
        });
        throw error;
      }
      this.logger?.error('vision.analyze.error', error, {
        attachmentCount: attachments.length,
        durationMs: Date.now() - start
      });
      throw error;
    }
  }
}

async function toDataUrl(attachment: Attachment, signal?: AbortSignal): Promise<{ url: string; local: boolean; bytes?: number }> {
  throwIfAborted(signal);
  if (/^https?:\/\//i.test(attachment.path) || attachment.path.startsWith('data:')) {
    return { url: attachment.path, local: false };
  }
  const absolutePath = path.resolve(attachment.path);
  const data = await readFile(absolutePath);
  throwIfAborted(signal);
  return {
    url: `data:${attachment.mimeType};base64,${data.toString('base64')}`,
    local: true,
    bytes: data.byteLength
  };
}
