// 从 shell 命令里粗取「会被写入/删除/改权限」的路径参数，供越界判断用。
// 越界即拦截并取消这一轮，所以宁可漏判不可误判：认不出的写法一律不报。
// 例外是包装命令（sudo/env/timeout…）的选项认不出时，后面每个非选项词都当命令开头试，
// 免得靠一个怪选项绕过。

type Word = { text: string; quoted: boolean };

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "|&", "\n"]);

/**
 * 简化的词法切分：处理单双引号、反斜杠、注释、重定向和 heredoc 正文。
 * 重定向目标不进参数列表（重定向另有检查）；heredoc 正文整段跳过，免得把文件内容当命令。
 */
function splitCommands(cmd: string): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let cur = "";
  let quoted = false;
  let inWord = false;
  let dropNext = false;
  const heredocs: Array<{ tag: string; strip: boolean }> = [];
  let pendingHeredoc: { strip: boolean } | null = null;
  const endWord = () => {
    if (!inWord) return;
    if (pendingHeredoc) {
      heredocs.push({ tag: cur, strip: pendingHeredoc.strip });
      pendingHeredoc = null;
    } else if (dropNext) dropNext = false;
    else words.push({ text: cur, quoted });
    cur = "";
    quoted = false;
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\n") {
      endCommand();
      i += 1;
      // heredoc 正文：逐行跳到结束标记
      while (heredocs.length && i <= cmd.length) {
        const end = cmd.indexOf("\n", i);
        const line = cmd.slice(i, end < 0 ? cmd.length : end);
        i = end < 0 ? cmd.length + 1 : end + 1;
        const doc = heredocs[0];
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.tag) heredocs.shift();
      }
      continue;
    }
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      cur += cmd.slice(i + 1, end < 0 ? cmd.length : end);
      quoted = inWord = true;
      i = end < 0 ? cmd.length : end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length) j += 1;
        cur += cmd[j];
        j += 1;
      }
      quoted = inWord = true;
      i = j + 1;
      continue;
    }
    if (ch === "\\") {
      if (cmd[i + 1] === "\n") i += 2;
      else {
        cur += cmd[i + 1] ?? "";
        inWord = true;
        i += 2;
      }
      continue;
    }
    if (ch === "#" && !inWord) {
      const end = cmd.indexOf("\n", i);
      i = end < 0 ? cmd.length : end;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      i += 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // 2>、&> 这类前缀是文件描述符，不是参数
      if (inWord && /^(?:\d+|&)$/.test(cur) && !quoted) {
        cur = "";
        inWord = false;
      }
      endWord();
      const op = /^(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)/.exec(cmd.slice(i))![0];
      i += op.length;
      if (op === "<<" || op === "<<-") pendingHeredoc = { strip: op === "<<-" };
      else if (op === "<&" || op === ">&") {
        // >&2 这类复制描述符后面紧跟数字，没有路径
        const fd = /^\s*(?:\d+|-)(?=\s|$|[;&|])/.exec(cmd.slice(i));
        if (fd) i += fd[0].length;
        else dropNext = true;
      } else dropNext = true;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      const op = /^(?:&&|\|\||\|&|;;|[;|&])/.exec(cmd.slice(i))![0];
      if (SEPARATORS.has(op) || op === ";;") {
        endCommand();
        i += op.length;
        continue;
      }
    }
    if (ch === "(" || ch === ")") {
      endCommand();
      i += 1;
      continue;
    }
    cur += ch;
    inWord = true;
    i += 1;
  }
  endCommand();
  return commands;
}

/**
 * 这些前缀之后才是真正的命令。flags 不带值、values 吃掉下一个词（或 -uX / --opt=X 自带值）；
 * scripts 的值本身是一条命令（env -S）；positionals 是命令前固定的位置参数个数（timeout 的时长）
 */
type WrapperSpec = { flags: string[]; values: string[]; scripts?: string[]; positionals?: number; assigns?: boolean };
const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: {
    flags: ["-A", "-B", "-b", "-E", "-H", "-K", "-k", "-N", "-n", "-P", "-S", "-V", "-v", "-l", "--preserve-env"],
    values: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-r", "-T", "-t", "-U", "--user", "--group", "--chdir"],
  },
  doas: { flags: ["-n", "-s", "-L"], values: ["-u", "-C"] },
  env: {
    flags: ["-", "-i", "-0", "-v", "--ignore-environment", "--null", "--debug"],
    values: ["-u", "--unset", "-C", "--chdir"],
    scripts: ["-S", "--split-string"],
    assigns: true,
  },
  nohup: { flags: [], values: [] },
  time: {
    flags: ["-p", "-v", "-a", "-q", "--portability", "--verbose", "--append", "--quiet"],
    values: ["-f", "-o", "--format", "--output"],
  },
  command: { flags: ["-p", "-v", "-V"], values: [] },
  exec: { flags: ["-c", "-l"], values: ["-a"] },
  builtin: { flags: [], values: [] },
  nice: { flags: [], values: ["-n", "--adjustment"] },
  ionice: { flags: ["-t", "--ignore"], values: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"] },
  timeout: {
    flags: ["-v", "--verbose", "--preserve-status", "--foreground"],
    values: ["-s", "--signal", "-k", "--kill-after"],
    positionals: 1,
  },
  stdbuf: { flags: [], values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  xargs: {
    flags: [
      "-0",
      "-r",
      "-t",
      "-p",
      "-x",
      "-o",
      "-i",
      "-e",
      "-l",
      "--null",
      "--no-run-if-empty",
      "--verbose",
      "--interactive",
      "--exit",
      "--open-tty",
    ],
    values: [
      "-I",
      "-L",
      "-n",
      "-P",
      "-s",
      "-d",
      "-E",
      "-a",
      "--arg-file",
      "--delimiter",
      "--max-args",
      "--max-procs",
      "--max-chars",
      "--max-lines",
    ],
  },
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** 各命令里带值的选项：值不是路径参数 */
const VALUE_OPTS: Record<string, Set<string>> = {
  cp: new Set(["-S", "--suffix"]),
  mv: new Set(["-S", "--suffix"]),
  ln: new Set(["-S", "--suffix"]),
  install: new Set(["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]),
  mkdir: new Set(["-m", "--mode", "-Z", "--context"]),
  truncate: new Set(["-s", "--size", "-r", "--reference"]),
  touch: new Set(["-d", "--date", "-t", "-r", "--reference"]),
  chmod: new Set(["--reference"]),
  chown: new Set(["--reference", "--from"]),
  chgrp: new Set(["--reference"]),
  rm: new Set(),
  rmdir: new Set(),
  unlink: new Set(),
  shred: new Set(["-n", "--iterations", "-s", "--size"]),
  rsync: new Set([
    "-e",
    "--rsh",
    "-f",
    "--filter",
    "--exclude",
    "--include",
    "--exclude-from",
    "--include-from",
    "--files-from",
    "-T",
    "--temp-dir",
    "--log-file",
    "--backup-dir",
    "--suffix",
    "--partial-dir",
    "--chmod",
    "--chown",
    "-M",
    "--remote-option",
    "--compare-dest",
    "--copy-dest",
    "--link-dest",
  ]),
};

/** 拆出非选项参数；--target-directory/-t 单独返回 */
function splitArgs(name: string, args: Word[]) {
  const valueOpts = VALUE_OPTS[name] ?? new Set<string>();
  const positional: string[] = [];
  let target: string | null = null;
  let endOfOpts = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i].text;
    if (endOfOpts || !word.startsWith("-") || word === "-") {
      positional.push(word);
      continue;
    }
    if (word === "--") {
      endOfOpts = true;
      continue;
    }
    const takesTarget = ["cp", "mv", "ln", "install"].includes(name);
    if (takesTarget && (word === "--target-directory" || /^-[a-zA-Z]*t$/.test(word))) {
      target = args[i + 1]?.text ?? null;
      i += 1;
      continue;
    }
    if (takesTarget && word.startsWith("--target-directory=")) {
      target = word.slice("--target-directory=".length);
      continue;
    }
    if (takesTarget && /^-[a-zA-Z]*t./.test(word)) {
      target = word.slice(word.indexOf("t") + 1);
      continue;
    }
    if (word.includes("=")) continue;
    if (valueOpts.has(word)) i += 1;
  }
  return { positional, target };
}

function sedFiles(args: Word[]): string[] {
  let inPlace = false;
  let scriptGiven = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i].text;
    if (word === "--in-place" || word.startsWith("--in-place=")) {
      inPlace = true;
      continue;
    }
    if (word === "-e" || word === "--expression" || word === "-f" || word === "--file") {
      scriptGiven = true;
      i += 1;
      continue;
    }
    if (word.startsWith("--expression=") || word.startsWith("--file=")) {
      scriptGiven = true;
      continue;
    }
    if (word === "-l" || word === "--line-length") {
      i += 1;
      continue;
    }
    if (/^-[a-zA-Z]+/.test(word) && !word.startsWith("--")) {
      // -i 之后的字符是备份后缀；-e/-f 在簇末尾时吃掉下一个参数
      const flags = word.slice(1);
      const at = flags.indexOf("i");
      const before = at >= 0 ? flags.slice(0, at) : flags;
      if (at >= 0) inPlace = true;
      if (/[ef]$/.test(before) && at < 0) {
        scriptGiven = true;
        i += 1;
      }
      continue;
    }
    if (word.startsWith("-") && word !== "-") continue;
    positional.push(word);
  }
  if (!inPlace) return [];
  return scriptGiven ? positional : positional.slice(1);
}

const isAssign = (word: Word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text) && !word.quoted;
const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** 跳过包装命令自己的选项，返回真正命令的下标；遇到认不出的选项返回 null */
function skipWrapper(name: string, spec: WrapperSpec, words: Word[], i: number) {
  const scripts: string[] = [];
  let positionals = spec.positionals ?? 0;
  const flag = (opt: string) => spec.flags.includes(opt) || (name === "nice" && /^-\d+$/.test(opt));
  while (i < words.length) {
    const word = words[i].text;
    // `--` 之后不再有选项，但固定位置参数（如 timeout 的时长）仍要跳过
    if (word === "--") return { next: Math.min(i + 1 + positionals, words.length), scripts };
    if (spec.assigns && isAssign(words[i])) {
      i += 1;
      continue;
    }
    if (!word.startsWith("-") || (word === "-" && !flag(word))) {
      if (positionals <= 0) break;
      positionals -= 1;
      i += 1;
      continue;
    }
    if (flag(word)) i += 1;
    else if (spec.values.includes(word)) i += 2;
    else if (spec.scripts?.includes(word)) {
      scripts.push(words[i + 1]?.text ?? "");
      i += 2;
    } else if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const opt = eq > 0 ? word.slice(0, eq) : word;
      if (eq > 0 && spec.scripts?.includes(opt)) scripts.push(word.slice(eq + 1));
      else if (eq < 0 || !(spec.values.includes(opt) || flag(opt))) return null;
      i += 1;
    } else if (spec.values.includes(word.slice(0, 2))) i += 1;
    else if (spec.scripts?.includes(word.slice(0, 2))) {
      scripts.push(word.slice(2));
      i += 1;
    } else {
      // 短选项簇：前面都得是开关，最后一个可以带值（-Hu root）
      const opts = [...word.slice(1)].map((c) => `-${c}`);
      const last = opts.pop()!;
      if (!opts.every(flag)) return null;
      if (flag(last)) i += 1;
      else if (spec.values.includes(last)) i += 2;
      else return null;
    }
  }
  return { next: i, scripts };
}

function targetsOf(words: Word[], depth: number, start = 0, guesses = 0): string[] {
  const out: string[] = [];
  let i = start;
  while (i < words.length) {
    if (isAssign(words[i])) {
      i += 1;
      continue;
    }
    const name = baseName(words[i].text);
    if (!Object.hasOwn(WRAPPERS, name)) break;
    const skipped = skipWrapper(name, WRAPPERS[name], words, i + 1);
    if (!skipped) {
      // 包装命令的写法认不出：后面每个非选项词都可能是命令开头，逐个试
      if (guesses >= 2) return out;
      for (let j = i + 1; j < words.length; j += 1)
        if (!words[j].text.startsWith("-")) out.push(...targetsOf(words, depth, j, guesses + 1));
      return out;
    }
    if (depth < 3) for (const script of skipped.scripts) out.push(...shellWriteTargetsAt(script, depth + 1));
    i = skipped.next;
  }
  if (i < words.length) out.push(...commandTargets(baseName(words[i].text), words.slice(i + 1), depth));
  return out;
}

function commandTargets(name: string, args: Word[], depth: number): string[] {
  if (SHELLS.has(name)) {
    const at = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg.text));
    const script = at >= 0 ? args[at + 1]?.text : undefined;
    return script && depth < 3 ? shellWriteTargetsAt(script, depth + 1) : [];
  }
  if (name === "sed") return sedFiles(args);
  if (name === "dd") return args.filter((arg) => arg.text.startsWith("of=")).map((arg) => arg.text.slice(3));
  if (name === "tee") return [];
  if (!(name in VALUE_OPTS)) return [];
  const { positional, target } = splitArgs(name, args);
  // mv 和 rsync --remove-source-files 会删掉源，源也算写入
  const movesSources =
    name === "mv" ||
    (name === "rsync" &&
      args.some((arg) => arg.text === "--remove-source-files" || arg.text === "--remove-sent-files"));
  if (movesSources) return target != null ? [...positional, target] : positional.length >= 2 ? positional : [];
  if (["cp", "ln", "install", "rsync"].includes(name)) {
    if (target != null) return [target];
    // install -d 只建目录，参数全是目标
    if (name === "install" && args.some((arg) => arg.text === "-d" || arg.text === "--directory")) return positional;
    return positional.length >= 2 ? [positional[positional.length - 1]] : [];
  }
  if (["chmod", "chown", "chgrp"].includes(name)) {
    const byReference = args.some((arg) => arg.text.startsWith("--reference"));
    return byReference ? positional : positional.slice(1);
  }
  return positional;
}

function shellWriteTargetsAt(cmd: string, depth: number): string[] {
  return splitCommands(cmd).flatMap((words) => targetsOf(words, depth));
}

/** 命令里写入类调用（cp/mv/install/ln 的目标、rm/touch/mkdir/chmod 等的路径、sed -i 的文件、dd of=）的路径参数 */
export function shellWriteTargets(cmd: string): string[] {
  return shellWriteTargetsAt(cmd, 0).filter(Boolean);
}
