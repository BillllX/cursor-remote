export const SAMPLE_CANVAS_PATH = ".cursor-remote/canvases/repo-overview.canvas.tsx";

export const SAMPLE_CANVAS_SOURCE = `import { useCanvasState, Stack, H1, H2, Text, Row, Stat, Card, CardHeader, CardBody, Table, BarChart, Toggle, Button, Callout } from "cursor/canvas";

export default function RepoOverview() {
  const [live, setLive] = useCanvasState("live", true);
  return (
    <Stack gap={16}>
      <H1>接驳概览</H1>
      <Text tone="secondary">网页说话，远端动手。下面是活 Canvas 样例。</Text>
      <Row gap={16}>
        <Stat value="3" label="模式" />
        <Stat value={live ? "开" : "关"} label="演示开关" tone={live ? "success" : "warning"} />
        <Stat value="8787" label="Gateway 端口" tone="info" />
      </Row>
      <Row gap={8} align="center">
        <Text size="small">交互</Text>
        <Toggle checked={live} onChange={setLive} />
        <Button variant="primary" onClick={() => setLive((value) => !value)}>
          切换
        </Button>
      </Row>
      {live ? (
        <Callout tone="info" title="活视图">
          点上面的开关或按钮，状态会留在这个面板里。点「源码」可看 .canvas.tsx。
        </Callout>
      ) : (
        <Callout tone="warning" title="已关闭">
          演示开关关上了，再打开就能回来。
        </Callout>
      )}
      <H2>服务</H2>
      <Table
        headers={["层", "作用", "端口"]}
        rows={[
          ["web", "公网聊天界面", "3020"],
          ["gateway", "远端工作区网关", "8787"],
          ["tunnel", "把 VPS 转到这台 Mac", "—"],
        ]}
        columnAlign={["left", "left", "right"]}
      />
      <H2>请求量（示意）</H2>
      <Card>
        <CardHeader>最近 5 天</CardHeader>
        <CardBody>
          <BarChart
            categories={["一", "二", "三", "四", "五"]}
            series={[{ name: "回合", data: [4, 8, 6, 11, 9] }]}
            valueSuffix=" 次"
          />
        </CardBody>
      </Card>
    </Stack>
  );
}
`;
