const config = require("dotenv").config().parsed;

for (const k in config) {
  process.env[k] = config[k];
}

const fs = require("fs");
const { LogLevel } = require("@slack/logger");
const logLevel = process.env.SLACK_LOG_LEVEL || LogLevel.DEBUG;

const express = require("express");
const { App, ExpressReceiver } = require("@slack/bolt");

const processBeforeResponse = false;
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse
});
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  logLevel,
  receiver,
  processBeforeResponse
});

// bot id
let bot_id = process.env.BOT_ID;

// channel_table = { channel_id: name, ... }
let channel_table = [];

// announce channel = { from(channel_id) : to(channel_id) , ...}
let announce_channel = {};

// ts_user = { user_id: { user: user_id, ts: ts, channel: channel_id, in_progress: false } }
let ts_user = {};

// メッセージ応答
app.event("app_mention", async ({ logger, client, event, say }) => {
  logger.debug("app_mention event payload:\n" + JSON.stringify(event, null, 2) + "\n");
  if (~event.text.indexOf("leave")) {
    if (channel_table.indexOf(event.channel) !== -1) {
      channel_table = channel_table.filter(c => c !== event.channel);
      writeConfig("channels.json", channel_table);
      say(`channel_id(${event.channel})を質問受付チャンネルから削除しました。`);
    }
    const leave = await client.conversations.leave({
      "channel": event.channel
    });
  } else if (~event.text.indexOf("setup")) {
    if (channel_table.indexOf(event.channel) !== -1) {
      say(`channel_id(${event.channel})は既に質問受付チャンネルとして登録されています。`);
    } else {
      say(`channel_id(${event.channel})を質問受付チャンネルとして登録しました。`);
      channel_table.push(event.channel);
      writeConfig("channels.json", channel_table);
    }
  } else if (~event.text.indexOf("announce")) {
    const inputs = event.text.split(" ");
    if (inputs[2] && channel_table.indexOf(inputs[2]) !== -1) {
      announce_channel[inputs[2]] = event.channel;
      say(`このチャンネル(${event.channel})を質問公開チャンネルとして登録します。`);
    } else if (inputs[2]) {
      say(`チャンネル${event.channel}は質問対応チャンネルとして登録されていません。`);
    } else {
      say(`USAGE : @QABot announce [channel_id]`);
    }
  }
});

// メッセージ応答
app.event("message", async ({ logger, client, event, say }) => {
  logger.debug("message event payload: \n" + JSON.stringify(event, null, 2) + "\n");

  if (event["channel_type"] === "im") {
    await parseDM({ logger, client, event }).catch((e) => logger.debug(e));
  } else if (event["channel_type"] === "channel" || event["channel_type"] === "group") {
    await parseThread({ logger, client, event }).catch((e) => logger.debug(e));
  }
});

// dm (DM->thread)
async function parseDM({ logger, client, event, say }) {
  if (!ts_user[event.user]) {
    //say("質問は講義チャンネルのワークフローから投稿してください。");
    return; //質問を受けていない場合、何もしない
  }
  const dm_info = ts_user[event.user];
  await redirectMessage({ client, logger }, dm_info.channel, event.text, dm_info.ts);
  await sendReaction({ logger, client, event });
}

// thread(TA->DM)
async function parseThread({ logger, client, event }) {
  if (channel_table.indexOf(event.channel) === -1) {
    return // XX_質問チャンネルでないなら、何もしない
  }
  // スレッドに書き込んだメッセージ && QABotが投下したメッセージ
  if (event.thread_ts && event.parent_user_id === bot_id) {
    const user = Object.keys(ts_user).filter((key) => {
      return ts_user[key].ts === event["thread_ts"];
    });
    // user_idが登録されていない、質問応対中出ない場合
    if (!user[0] || !ts_user[user[0]].in_progress) {
      return;
    }
    await redirectMessage({ client, logger }, user[0], event.text, null);
    await sendReaction({ logger, client, event });
  }
}

app.event("reaction_added", async ({ logger, client, event }) => {
  logger.debug("reaction_added event payload:\n" + JSON.stringify(event, null, 2) + "\n");

  const user = Object.keys(ts_user).filter((key) => {
    return ts_user[key].ts === event.item.ts;
  });

  if (user[0]) {
    if (event.reaction === "対応中" && !ts_user[user[0]].in_progress) {
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel,
        text: "[対応開始]以降のスレッドは質問者に転送されます。対応が終了した場合、 :対応済2: をスレッドトップのメッセージにつけてください。",
        thread_ts: ts_user[user[0]].ts
      }).catch((e) => logger.debug(e));
      ts_user[user[0]].in_progress = true;
      writeConfig("ts_user.json", ts_user);
    }
    if (event.reaction === "対応済2" && ts_user[user[0]]) {
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel,
        text: "[対応終了]以降のスレッドは転送されません。",
        thread_ts: ts_user[user[0]].ts
      }).catch((e) => logger.debug(e));
      await client.chat.postMessage({
        channel: user[0],
        text: "[対応終了]以降のやりとりは転送されません。",
      }).catch((e) => logger.debug(e));
      delete ts_user[user[0]];
      writeConfig("ts_user.json", ts_user);
    }
  }
});

// reaction削除
app.event("reaction_removed", async ({ logger, client, event, say }) => {
  logger.debug("reaction_removed event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
  const user = Object.keys(ts_user).filter((key) => { return ts_user[key].ts == event.item.ts });
  if (event.reaction === "対応中" && ts_user[user[0]]) {
    // 対応中を取り消した場合()
    await client.chat.postMessage({
      channel: ts_user[user[0]].channel,
      text: "[対応中止] :対応中: が取り消されました。スレッドの転送を中止します。再開するには、もう一度質問のトップメッセージに :対応中: でリアクションしてください。",
      thread_ts: ts_user[user[0]].ts
    }).catch((e) => logger.debug(e));
    ts_user[user[0]].in_progress = false;
    writeConfig("ts_user.json", ts_user);
  }
  if (event.reaction === "対応済2") {
    // 対応済を取り消した場合(再アクセス)
    const messages = await client.conversations.replies({
      channel: event.item.channel,
      ts: event.item.ts
    }).catch((e) => logger.debug(e));
    if (messages["messages"] && messages["messages"][0]) {
      // テキストの行頭に質問者をつけているので、これでmatchするはず
      logger.debug(messages["messages"][0]["text"]);
      const user_id = messages["messages"][0]["text"].match(/<@([0-9a-zA-Z]*)>/)[1];
      const ts = messages["messages"][0]["ts"];
      if (user_id && user_id[1]) {
        ts_user[user_id] = { user: user_id, ts: event.item.ts, channel: event.item.channel, in_progress: true };
        writeConfig("ts_user.json", ts_user);
      }
      // threadに投稿
      await client.chat.postMessage({
        channel: event.item.channel,
        text: "[対応再開] :対応済2: が取り消されたので、スレッドの転送を再開します。",
        thread_ts: event.item.ts
      }).catch((e) => logger.debug(e));
      // userに投稿
      await client.chat.postMessage({
        channel: user_id,
        text: "[自動応答] 応答が再開されました。",
      }).catch((e) => logger.debug(e));
    }
  }
});

// workflow steps
app.action({ type: 'workflow_step_edit', callback_id: "qabot_v2_workflow_edit" }, async ({ body, ack, client, logger }) => {
  logger.debug("workflow_step_edit: " + JSON.stringify(body, null, 2));
  // Acknowledge the event
  await ack();
  // Open the configuration modal using `views.open`
  await openWorkflowModal({ logger, client, ack, body });
});

// workflow用のモーダル
async function openWorkflowModal({ logger, client, ack, body }) {
  try {
    const res = await client.views.open({
      "trigger_id": body.trigger_id,
      view: {
        type: "workflow_step",
        callback_id: "qabot_v2_workflow",
        blocks: [
          {
            "type": "input",
            "block_id": "qabot_input_channel_id",
            "element": {
              "type": "plain_text_input",
              "action_id": "channel_id"
            },
            "label": {
              "type": "plain_text",
              "text": "質問チャンネルのID",
              "emoji": true
            }
          },
          {
            "type": "input",
            "block_id": "qabot_input_questioner",
            "element": {
              "type": "plain_text_input",
              "action_id": "from"
            },
            "label": {
              "type": "plain_text",
              "text": "質問者",
              "emoji": true
            }
          },
          {
            "type": "input",
            "block_id": "qabot_input_qtype",
            "element": {
              "type": "plain_text_input",
              "action_id": "q_type"
            },
            "label": {
              "type": "plain_text",
              "text": "質問の種類",
              "emoji": true
            }
          },
          {
            "type": "input",
            "block_id": "qabot_input_values",
            "element": {
              "type": "plain_text_input",
              "action_id": "question",
              "multiline": true
            },
            "label": {
              "type": "plain_text",
              "text": "質問内容",
              "emoji": true
            }
          }
        ]
      }
    });
  } catch (e) {

  }
}

// workflowのview更新
app.view("qabot_v2_workflow", async ({ logger, client, view, body, ack }) => {
  logger.debug("qabot_workflow view : " + JSON.stringify(body, null, 2) + "\n");
  await ack();
  let workflowEditId = body.workflow_step.workflow_step_edit_id;
  let from = view.state.values.qabot_input_questioner.from;
  let type = view.state.values.qabot_input_qtype.q_type;
  let question = view.state.values.qabot_input_values.question;
  let channel_id = view.state.values.qabot_input_channel_id.channel_id;

  await client.workflows.updateStep({
    workflow_step_edit_id: workflowEditId,
    inputs: {
      channel_id: { value: (channel_id || "") },
      from: { value: (from || "") },
      type: { value: (type || "") },
      question: { value: (question || "") }
    },
    outputs: [
      {
        name: "channel_id",
        type: "text",
        label: "Channel"
      },
      {
        name: "from",
        type: "text",
        label: "Questioner"
      },
      {
        name: "type",
        type: "text",
        label: "Question Type"
      },
      {
        name: "question",
        type: "text",
        label: "Question"
      }
    ]
  });
});

// workflowの実行
app.event("workflow_step_execute", async ({ logger, client, event }) => {
  logger.debug("workflow_step_execute: " + JSON.stringify(event, null, 2) + "\n");
  // ここで実行処理
  let workflowExecuteId = event.workflow_step.workflow_step_execute_id;
  let inputs = event.workflow_step.inputs

  logger.debug("inputs: " + JSON.stringify(inputs, null, 2) + "\n");

  await client.workflows.stepCompleted({
    workflow_step_execute_id: workflowExecuteId,
    outputs: {
      channel_id: inputs.channel_id.value,
      name: inputs.from.value,
      question: inputs.question.value,
      type: inputs.question.type
    }
  });
  // ユーザ追加処理
  const channel_id = inputs.channel_id.value.value;
  const user = inputs.from.value.value.match(/<@([0-9a-zA-Z]*)>/)[1];
  const type = inputs.type.value.value;
  let question_text = `[${inputs.type.value.value}]\n${inputs.question.value.value}`;
  if (!type || type === "" || type === "匿名" || type === "None" || type === "その他" || type == null) {
    question_text = `${inputs.question.value.value}`
  }

  // もしすでに質問対応を行っていた場合
  if (ts_user[user]) {
    const dm_info = ts_user[user];
    await redirectMessage({ client, logger }, dm_info.channel, question_text, dm_info.ts);
    await client.chat.postMessage({
      channel: user, text: question_text
    }).catch((e) => logger.debug(e));
    return;
  }
  let pre_text = `<@${user}>さんが質問を投稿しました\n`;
  if (type == "匿名") {
    pre_text = "";
  }
  const suf_text = "\nスレッドを介してやりとりするには :対応中: でリアクションしてください。";
  const result = await client.chat.postMessage({ channel: channel_id, text: pre_text + question_text + suf_text, blocks: generateQuestionBlock(pre_text, question_text, suf_text) }).catch((e) => logger.debug(e));
  //logger.debug(question_text);
  // 質問受付リストに登録
  ts_user[user] = { user: user, ts: result.ts, channel: channel_id, in_progress: false };
  // config
  writeConfig("ts_user.json", ts_user);
  //logeer.debug(JSON.stringify(result, null, 2));
  await client.chat.postMessage({
    channel: user, text: question_text
  }).catch((e) => logger.debug(e));
  await client.chat.postMessage({ channel: user, text: "[自動応答]質問を受け付けました。返信をお待ちください。" }).catch((e) => logger.debug(e));
});

// リダイレクト機能
async function redirectMessage({ client, logger }, channel, text, ts) {
  // 多分ts==nullならいい感じにしてくれるけど、条件分岐を設定しておく
  let txt = text || "送信できないデータ(画像/ファイル)";
  if (ts) {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": txt,
      "thread_ts": ts
    }).catch((e) => logger.debug(e));
    return result;
  } else {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": txt
    }).catch((e) => logger.debug(e));
    return result;
  }
}

// 質問内容 Block Kit
function generateQuestionBlock(prefix_text, main_text, suffix_text) {
  let blocks = [];
  if (prefix_text !== "") {
    blocks.push(
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": prefix_text
        }
      }
    );
  }
  blocks.push(
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": main_text
      }
    }
  );
  blocks.push(
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": suffix_text
      }
    }
  );
  return blocks;
}

// 送信済リアクション
async function sendReaction({ logger, client, event }) {
  const result = await client.reactions.add({
    "channel": event.channel,
    "name": "white_check_mark",
    "timestamp": event.event_ts
  }).catch((e) => logger.debug(e));
}

// PrivateChannelListを取得
async function getPrivateChanenlList({ client }) {
  const param = {
    "types": "private_channel",
    "limit": 100 // default
  };
  const channels = [];
  function pageLoaded(res) {
    res.channels.forEach(c => channels.push(c.id));
    if (res.response_metadata && res.response_metadata.next_cursor && res.response_metadata.next_cursor !== '') {
      param.cursor = res.response_metadata.next_cursor;
      return client.users.conversations(param).then(pageLoaded);
    }
    return channels;
  }
  return client.users.conversations(param).then(pageLoaded);
}

async function setBotID(client) {
  const test = await client.auth.test({
    token: process.env.SLACK_BOT_TOKEN
  });
  console.log(test);
  bot_id = test.user_id;
}

function existsConfig(filename) {
  return fs.existsSync(`./config/${filename}`);
}

function readConfig(filename) {
  return JSON.parse(fs.readFileSync(`./config/${filename}`));
}

function writeConfig(filename, json_object) {
  fs.writeFileSync(`./config/${filename}`, JSON.stringify(json_object));
}

// health check
receiver.app.get("/", (_req, res) => {
  res.send("Bolt App is running!");
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("Bolt app is runnning!");

  await setBotID(app.client);

  if (existsConfig("channels.json")) {
    channel_table = readConfig("channels.json");
  }
  if (existsConfig("ts_user.json")) {
    ts_user = readConfig("ts_user.json");
  }
})();
