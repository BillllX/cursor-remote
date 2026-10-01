/** 写进 Agent 模式的系统提示。命令不存在时不要提前告诉模型。 */
export const PUBLISH_AGENT_PROMPT = [
  "对外预览：用户要从外网打开当前工作区里的网站或接口时，用 shell 执行 jiebo-publish start -- <启动命令>。",
  "启动命令必须监听环境变量 HOST 和 PORT（HOST 是 127.0.0.1），并把网站挂在 BASE_PATH 下。要写进命令时用单引号 '$HOST'、'$PORT'、'$BASE_PATH'，避免当前 shell 先展开成空。",
  "Vite 用 --base '$BASE_PATH/'，Next 的 basePath 用 BASE_PATH。浏览器里的资源地址必须落在这个前缀下。",
  "把命令打印出的地址原样回复给用户。",
  "不要自己选端口，不要绑定 0.0.0.0，不要改 nginx、hosts 或证书。",
  "已经公开过就先 jiebo-publish stop。查看用 jiebo-publish status。",
].join("");

export const PUBLISH_BUILDER_ZH =
  "用户要从外网打开这个工作区的网站或接口时，用 shell 执行 jiebo-publish start -- <启动命令>。命令须监听 HOST 和 PORT，并把网站挂在 BASE_PATH 下（Vite 用 --base '$BASE_PATH/'，Next 的 basePath 用 BASE_PATH）。把打印出的地址原样写进结果。不要自己选端口，不要绑定 0.0.0.0，不要改 nginx。再次公开先 jiebo-publish stop。";

export const PUBLISH_BUILDER_EN =
  "To publish this workspace's website or API, run jiebo-publish start -- <command>. The command must listen on HOST and PORT and serve under BASE_PATH (Vite: --base '$BASE_PATH/'; Next basePath: BASE_PATH). Return the printed URL unchanged. Do not pick a port, bind 0.0.0.0, or edit nginx. Run jiebo-publish stop before publishing again.";
