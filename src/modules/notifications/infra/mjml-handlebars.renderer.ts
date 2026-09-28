import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TemplateNotFoundError,
  TemplateRenderer,
  type RenderedEmail,
} from '../ports/template-renderer.js';
import {
  LOCALE_PATTERN,
  TEMPLATE_KEYS,
  type TemplateKey,
  type TemplateParams,
} from '../templates.js';

export const NOTIFICATION_TEMPLATES_DIR = Symbol('notifications.templatesDir');
export const NOTIFICATION_RENDER_OPTIONS = Symbol(
  'notifications.renderOptions',
);
/** `src/…/templates` khi chạy TS, `dist/…/templates` sau build (assets của nest-cli, spike S6). */
export const defaultTemplatesDir = (): string =>
  fileURLToPath(new URL('../templates/', import.meta.url));

type Compiled = {
  subject: HandlebarsTemplateDelegate;
  html: HandlebarsTemplateDelegate;
  text: HandlebarsTemplateDelegate;
};
type HandlebarsTemplateDelegate = ReturnType<typeof Handlebars.compile>;
type CompileOptions = NonNullable<Parameters<typeof Handlebars.compile>[1]>;

/**
 * Chỉ compile file trong repo, lúc boot (spec §5.11, research 4): mjml `validationLevel: 'strict'`, không
 * include; handlebars `strict` + `knownHelpersOnly`, instance riêng, không helper, không bật prototype access.
 * HTML escape tham số; subject/text dùng `noEscape` (không phải HTML; CR/LF đã bị chặn ở schema params).
 */
@Injectable()
export class MjmlHandlebarsRenderer
  extends TemplateRenderer
  implements OnModuleInit
{
  private readonly compiled = new Map<string, Compiled>();
  private readonly hbs = Handlebars.create();

  constructor(
    @Inject(NOTIFICATION_TEMPLATES_DIR) private readonly dir: string,
    @Inject(NOTIFICATION_RENDER_OPTIONS)
    private readonly opts: { defaultLocale: string },
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    for (const template of TEMPLATE_KEYS) {
      const locales = readdirSync(join(this.dir, template)).filter((l) =>
        LOCALE_PATTERN.test(l),
      );
      for (const locale of locales)
        this.compiled.set(
          `${template}/${locale}`,
          await this.compile(template, locale),
        );
    }
    const missing = TEMPLATE_KEYS.filter(
      (t) => !this.compiled.has(`${t}/${this.opts.defaultLocale}`),
    );
    if (missing.length)
      throw new Error(
        `missing templates for locale "${this.opts.defaultLocale}": ${missing.join(', ')}`,
      );
  }

  render<K extends TemplateKey>(
    template: K,
    locale: string,
    params: TemplateParams<K>,
  ): RenderedEmail {
    const c = this.compiled.get(`${template}/${locale}`);
    if (!c) throw new TemplateNotFoundError(template, locale);
    return {
      subject: c.subject(params).trim(),
      html: c.html(params),
      text: c.text(params),
    };
  }

  private async compile(template: string, locale: string): Promise<Compiled> {
    const base = join(this.dir, template, locale);
    const read = (f: string) => readFileSync(join(base, f), 'utf8');
    let html: string;
    try {
      const out = await mjml2html(read('body.mjml'), {
        validationLevel: 'strict',
        ignoreIncludes: true,
      });
      html = out.html;
    } catch (err) {
      throw new Error(`invalid template ${template}/${locale}/body.mjml`, {
        cause: err,
      });
    }
    const strict = { strict: true, knownHelpersOnly: true } as const;
    return {
      subject: this.compileHbs(
        `${template}/${locale}/subject.hbs`,
        read('subject.hbs'),
        { ...strict, noEscape: true },
      ),
      html: this.compileHbs(`${template}/${locale}/body.mjml`, html, strict),
      text: this.compileHbs(
        `${template}/${locale}/text.hbs`,
        read('text.hbs'),
        { ...strict, noEscape: true },
      ),
    };
  }

  /**
   * `compile` của handlebars là lazy (lỗi cú pháp chỉ lộ ở lần render đầu, trong job). `precompile` parse và
   * biên dịch ngay, kể cả kiểm `knownHelpersOnly`: template hỏng làm boot fail, có tên file (review M8).
   */
  private compileHbs(
    file: string,
    source: string,
    options: CompileOptions,
  ): HandlebarsTemplateDelegate {
    try {
      this.hbs.precompile(source, options);
    } catch (err) {
      throw new Error(`invalid template ${file}`, { cause: err });
    }
    return this.hbs.compile(source, options);
  }
}

export { TemplateNotFoundError } from '../ports/template-renderer.js';
