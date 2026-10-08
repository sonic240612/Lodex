import { AppError } from '@lodex/contracts';

/** llama.cpp's standard shard naming, with a bounded complete group. */
export function splitModelFiles(file: string): string[] {
  const match = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(file);
  if (!match) return [file];
  const index = Number(match[2]),
    count = Number(match[3]);
  if (count < 1 || count > 256 || index < 1 || index > count)
    throw new AppError('GGUF_SPLIT', '분할 GGUF 번호가 올바르지 않거나 256개를 초과합니다.');
  return Array.from(
    { length: count },
    (_, i) => `${match[1]}-${String(i + 1).padStart(5, '0')}-of-${match[3]}.gguf`,
  );
}
