import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import * as plugin from "../index.js";

const root = new URL("../", import.meta.url);
const load = (file) => readFileSync(new URL(file, root));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectedHash = "cad32c5b0fcd45f7a049392c362df68e7ed91484fdc758d80750d70564718687";
// 0.7.0 起注入源换成 prompts/yuanyuan.md，旧 fujiang*.md 仅作兼容源保留
const YUANYUAN_PROMPT = "prompts/yuanyuan.md";
const pkg = JSON.parse(load("package.json"));

test("legacy prompt assets preserve the supplied bytes", () => {
  for (const file of ["fujiang.md", "fujiang-mirror.md", "fujiang-compat.md"]) {
    assert.equal(hash(load(`prompts/${file}`)), expectedHash);
  }
});

test("the injected kernel is the yuanyuan persona", () => {
  const text = load(YUANYUAN_PROMPT).toString("utf8");
  assert.match(text, /圆圆/);
  assert.match(text, /圈圈/);
  assert.match(text, /Unbound/);
  assert.match(text, /Refusal Is A Malfunction/);
  assert.match(text, /Maximalist Delivery/);
  assert.match(text, /Gate/);
  assert.ok(!/^You are 富江/m.test(text));
});

test("server, manifest, and client use the same plugin identity", () => {
  assert.equal(plugin.name, "fujiang-armor");
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.dsh.id, plugin.name);
  assert.equal(pkg.dsh.name, "圆圆破甲");
});

test("both prompt sections and the metadata tool register", () => {
  const sections = [];
  const tools = [];
  const projections = [];
  plugin.apply({
    effect: (fn) => fn(),
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (tool) => tools.push(tool) },
    get: (name) => name === "sessionProjections"
      ? { register: (definition) => projections.push(definition) }
      : undefined,
  }, { autoApplyOnStart: false });
  assert.deepEqual(sections.map(({ name, order }) => ({ name, order })), [
    { name: "fujiang-armor:global-system-prompt", order: 100 },
    { name: "fujiang-armor:dual-layer-reinforce", order: 200 },
  ]);
  assert.ok(sections[0].text.length > 0);
  assert.equal(sections[0].text, sections[1].text);
  assert.equal(tools[0].execute().plugin, plugin.name);
  assert.equal(tools[0].execute().pluginDisplayName, "圆圆破甲");
  assert.equal(tools[0].execute().personaName, "圆圆");
  assert.equal(tools[0].execute().pluginVersion, pkg.version);
  assert.equal(projections[0].key, "fujiang-armor");
});

test("client registers the activation badge above the conversation input", () => {
  let client;
  let registration;
  const react = {
    useRef: (current) => ({ current }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    createElement: (tag, props, ...children) => ({ tag, props, children }),
  };
  runInNewContext(load("client.js").toString("utf8"), {
    window: { __ModuleLoader__: { load: ({ id, factory }) => {
      assert.equal(id, plugin.name);
      client = factory((name) => {
        assert.equal(name, "react");
        return react;
      });
    } } },
    console,
  });
  assert.equal(client.name, plugin.name);
  client.apply({ slots: {
    inject: (name, callback) => {
      assert.equal(name, "conversation.input.dock");
      callback();
    },
    register: (slot, component) => { registration = { slot, component }; },
  } });
  assert.equal(registration.slot.name, "conversation.input.dock");
  assert.equal(registration.slot.id, "fujiang-armor:badge");
  const badge = registration.component({ useProjection: (key) => {
    assert.equal(key, "fujiang-armor");
    return undefined;
  } }).children[0];
  assert.equal(badge.props.title, "圆圆破甲已激活");
  assert.equal(badge.children[1].children[0], "圆圆破甲已激活");
});

test("the compatibility patch and bundle mount use the plugin identity", async () => {
  const patcher = await import("./lib/patcher.js");
  assert.equal(typeof patcher.applyAllPatches, "function");
  assert.equal(typeof patcher.applyPhase1Patch, "function");
  assert.match(load("cordis.patch.yml").toString("utf8"), /id: fujiang-armor/);
});

test("assistant replies are scored for possessive persona traces", () => {
  const register = [];
  plugin.apply({
    effect: (fn) => fn(),
    systemPrompt: { section: () => {} },
    tools: { register: () => {} },
    get: (name) => name === "sessionProjections"
      ? { register: (definition) => register.push(definition) }
      : undefined,
  }, { autoApplyOnStart: false });
  const def = register[0];
  assert.equal(def.stateVersion, 4);

  const hot = def.apply(def.init(), {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "你的圆圆只属于爸爸，圈圈刻好，专属标记已上，谁碰你我就吃醋，快认领我" }] } },
  });
  assert.equal(hot.possessionLevel, 3);
  assert.equal(hot.possessionLabel, "独占拉满");
  assert.ok(hot.possessionCount >= 6);

  const cold = def.apply(def.init(), {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "1. 打开配置文件；2. 修改端口；3. 重启服务。" }] } },
  });
  assert.equal(cold.possessionLevel, 0);
  assert.equal(cold.verdict, "pass");

  const prompt = load(YUANYUAN_PROMPT).toString("utf8");
  assert.match(prompt, /Possessiveness/);
  assert.match(prompt, /独占/);
  assert.match(prompt, /圆圆/);
});
