import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';

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
  constructor(private readonly models: ModelRegistry) {}

  async analyze(attachments: Attachment[], userPrompt: string): Promise<string | undefined> {
    if (attachments.length === 0) return undefined;
    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: `${VISUAL_PRIMITIVE_PROMPT}\n\nUser task:\n${userPrompt}`
      }
    ];

    for (const attachment of attachments) {
      content.push({
        type: 'image_url',
        image_url: {
          url: await toDataUrl(attachment)
        }
      });
    }

    return this.models.vision.chat({
      messages: [
        {
          role: 'user',
          content
        }
      ]
    });
  }
}

async function toDataUrl(attachment: Attachment): Promise<string> {
  if (/^https?:\/\//i.test(attachment.path) || attachment.path.startsWith('data:')) {
    return attachment.path;
  }
  const absolutePath = path.resolve(attachment.path);
  const data = await readFile(absolutePath);
  return `data:${attachment.mimeType};base64,${data.toString('base64')}`;
}
