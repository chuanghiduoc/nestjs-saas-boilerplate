import {
  Body,
  Controller,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CoreErrors } from '../../../src/core/errors/index.js';
import {
  ApiProblems,
  HttpModule,
  applyHttpDefaults,
  buildOpenApi,
  setupApiDocs,
} from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.0';
const CreateThing = z.object({ name: z.string().min(1) });

@Controller('api/v1/things')
class ThingsController {
  @Post()
  @ApiProblems(CoreErrors.VALIDATION_FAILED, CoreErrors.CONFLICT)
  create(@Body({ schema: CreateThing }) b: z.infer<typeof CreateThing>) {
    return b;
  }
}
@Module({ controllers: [ThingsController] })
class M {}

const nonceOf = (csp: string): string | undefined =>
  /script-src [^;]*'nonce-([^']+)'/.exec(csp)?.[1];

describe('API docs (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('HTTP_DOCS_ENABLED', 'true');
    vi.stubEnv('HTTP_DOCS_CDN_URL', CDN);
    app = await createTestApp([RedisModule, HttpModule, M], {
      beforeInit: (a) => {
        applyHttpDefaults(a);
        setupApiDocs(a);
      },
    });
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('builds an OpenAPI 3.1 document with zod request schemas and problem responses', () => {
    const doc = buildOpenApi(app, 'test');
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components?.schemas?.Problem).toMatchObject({
      type: 'object',
    });
    const op = doc.paths['/api/v1/things']?.post;
    expect(JSON.stringify(op?.requestBody)).toContain('"minLength":1');
    expect(op?.responses['422']).toMatchObject({
      content: {
        'application/problem+json': {
          schema: { $ref: '#/components/schemas/Problem' },
        },
      },
    });
    expect(op?.responses['409']).toBeDefined();
  });

  it('serves the Scalar UI under a CSP that authorises exactly its scripts', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy']);
    const nonce = nonceOf(csp);
    expect(nonce).toBeTruthy();
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-eval'/);
    const scripts = [...res.text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(res.text).toContain(`src="${CDN}"`);
    expect(res.text).toContain('/api/v1/things');

    const again = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(nonceOf(String(again.headers['content-security-policy']))).not.toBe(
      nonce,
    );
  });

  it('API routes keep the strict default CSP', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/things')
      .send({ name: 'x' })
      .expect(201);
    expect(res.headers['content-security-policy']).toContain(
      "script-src 'self';",
    );
  });
});
