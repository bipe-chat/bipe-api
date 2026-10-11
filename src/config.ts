import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  SERVER_NAME: z.string().min(1),
  SYNAPSE_URL: z.url(),
  // MAS web listener (token endpoint) and admin API listener. Both internal only.
  MAS_URL: z.url(),
  MAS_ADMIN_URL: z.url(),
  MAS_CLIENT_ID: z.string().min(1),
  MAS_CLIENT_SECRET: z.string().min(16),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    // Names only: never print values, some are secrets.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid environment: ${names}`);
  }
  return parsed.data;
}
