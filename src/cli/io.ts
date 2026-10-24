export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};
