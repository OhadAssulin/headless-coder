export interface Env {
  acpToken: string | null;
}

export const env: Env = {
  acpToken: process.env.ACP_TOKEN?.trim() || null,
};
