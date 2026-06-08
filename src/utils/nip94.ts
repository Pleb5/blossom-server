export type Nip94Tag = [name: string, value: string, ...rest: string[]];

export interface Nip94Metadata {
  url: string;
  sha256: string;
  size: number;
  type: string;
  dim?: string | null;
  originalSha256?: string | null;
}

export function nip94Fields(metadata: Nip94Metadata): { nip94: Nip94Tag[] } {
  const tags: Nip94Tag[] = [
    ["url", metadata.url],
    ["m", metadata.type.toLowerCase()],
    ["x", metadata.sha256],
    ["size", String(metadata.size)],
  ];

  if (metadata.originalSha256) tags.push(["ox", metadata.originalSha256]);
  if (metadata.dim) tags.push(["dim", metadata.dim]);

  return { nip94: tags };
}
