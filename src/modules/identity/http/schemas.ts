import { z } from 'zod';

export const MeResponse = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  emailVerified: z.boolean(),
  role: z.enum(['USER', 'ADMIN']),
  twoFactorEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MeResponse = z.infer<typeof MeResponse>;
