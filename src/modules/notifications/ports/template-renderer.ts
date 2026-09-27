import type { TemplateKey, TemplateParams } from '../templates.js';

export type RenderedEmail = { subject: string; html: string; text: string };

export class TemplateNotFoundError extends Error {
  constructor(template: string, locale: string) {
    super(`No compiled template ${template}/${locale}`);
    this.name = 'TemplateNotFoundError';
  }
}

export abstract class TemplateRenderer {
  abstract render<K extends TemplateKey>(
    template: K,
    locale: string,
    params: TemplateParams<K>,
  ): RenderedEmail;
}
