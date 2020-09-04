// `cp _env .env` then modify it
// See https://github.com/motdotla/dotenv
const config = require("dotenv").config().parsed;
// Overwrite env variables anyways
for (const k in config) {
  process.env[k] = config[k];
}

const { LogLevel } = require("@slack/logger");
const logLevel = process.env.SLACK_LOG_LEVEL || LogLevel.DEBUG;

const express = require("express");
const { App, ExpressReceiver } = require("@slack/bolt");
// If you deploy this app to FaaS, turning this on is highly recommended
// Refer to https://github.com/slackapi/bolt/issues/395 for details
const processBeforeResponse = false;
// Manually instantiate to add external routes afterwards
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse,
});
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  logLevel,
  receiver,
  processBeforeResponse,
});

// 質問対応チャンネル
const channel_id = process.env.CHANNEL_ID;
// 動作するBotID
const bot_id = process.env.BOT_ID;
// 質問者の連想リスト
const ts_user = {}; // ts_user[event.user] = { user: event.user, ts: result.ts, channel: channel_id, in_progress: false }
// 質問対応者リスト
let membersList = [];
// 質問回数リスト
let questioner_map = {};
// ラウンドロピンのカウンター
let rbcounter = 0;
// pickup state
let state = process.env.PICKUP_METHOD || "ROUNDROBIN" // ROUNDROBIN, RANDOM, RATIO

// Request dumper middleware for easier debugging
if (process.env.SLACK_REQUEST_LOG_ENABLED === "1") {
  app.use(async (args) => {
    const copiedArgs = JSON.parse(JSON.stringify(args));
    copiedArgs.context.botToken = 'xoxb-***';
    if (copiedArgs.context.userToken) {
      copiedArgs.context.userToken = 'xoxp-***';
    }
    copiedArgs.client = {};
    copiedArgs.logger = {};
    args.logger.debug(
      "Dumping request data for debugging...\n\n" +
      JSON.stringify(copiedArgs, null, 2) +
      "\n"
    );
    const result = await args.next();
    args.logger.debug("next() call completed");
    return result;
  });
}

// ---------------------------------------------------------------
// Start coding here..
// see https://slack.dev/bolt/

// https://api.slack.com/apps/{APP_ID}/event-subscriptions
// ---------------------------------------------------------------

// appメンションを受けた場合
app.event("app_mention", async ({ logger, client, event, say }) => {
  logger.debug("app_mention event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
  if (~event.text.indexOf("leave")) {
    // チャンネル退室機能。（誤って追加した場合）
    const leave = await client.conversations.leave({
      "channel": event.channel
    });
    logger.debug("leabe result:\n\n" + JSON.stringify(leave, null, 2) + "\n");
    return leave;
  }
  // 以降は指定したチャンネル（質問対応チャンネル）のみで動作
  if (event.channel !== channel_id) {
    const leave = await client.conversations.leave({
      "channel": event.channel
    });
    return leave;
  }
  if (~event.text.indexOf("pick")) {
    if (!membersList || membersList.length == 0) {
      say(`リストが0人です。`);
    } else {
      const choise = choiseOne();
      //membersList[Math.floor(Math.random() * membersList.length)];
      say(`選ばれたのは...<@${choise}>でした。(${state})`);
    }
    return;
  } else if (~event.text.indexOf("state")) {
    await client.chat.postMessage({
      channel: channel_id,
      text: `Pickup: ${state}\nAnswers: ` + JSON.stringify(membersList, null, 2)
    });
  } else if (~event.text.indexOf("reset")) {
    membersList = await getMembers(channel_id, app.client);
    rbcounter = Math.floor(Math.random() * membersList.length);
    return;
  } else {
    const text = `:wave: <@${event.user}> Hi there!\n`
      + "\nメンションにキーワードをつけると各種機能を呼び出します"
      + "\n[pick] メンバーから一人ピックアップします"
      + "\n[reset] メンバーリストを再読み込みします"
      + "\n[leave] Appをチャンネルから退室させます"
      + "\n[state] 現在の設定を表示します"
    const result = await say({ text: text });
    logger.debug("say result:\n\n" + JSON.stringify(result, null, 2) + "\n");
    return result;
  }
});

// メッセージの着信
app.event("message", async ({ logger, client, event, say }) => {
  logger.debug("message.im event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
  logger.debug(ts_user);
  if (event["subtype"] === "message_changed" || event["subtype"] === "message_deleted") {
    // もし新規投稿以外であれば(bot-message, message-changed, message-deleted)
    return
  }
  if (event["channel_type"] === "im") {
    // im
    if (ts_user[event.user]) {
      // 質問をすでに受けている場合、質問スレッドに追記してやりとりを続ける。
      logger.debug("スレッドにRedirect");
      const dm_info = ts_user[event.user]
      await redirectMessage({ client }, dm_info.channel, event.text, dm_info.ts);
    } else {
      // メッセージが登録されていない場合（初質問)

      /* この辺でメッセージの確認をする(「質問があります」を省く？) */

      logger.debug("チャンネルにRedirect(質問初投稿)");
      const pre_text = `<@${event.user}>さんが質問を投稿しました\n`;
      const suf_text = "\n\n責任者は" + `<@${choiseOne()}>` + "さんに割り当てられました。\nスレッドを介してやりとりするには :対応中: でリアクションしてください。";
      const result = await client.chat.postMessage({ channel: channel_id, text: pre_text + event.text + suf_text, blocks: generateQuestionBlock(pre_text, event.text, suf_text) });
      // 質問受付リストに登録
      ts_user[event.user] = { user: event.user, ts: result.ts, channel: channel_id, in_progress: false };
      //logeer.debug(JSON.stringify(result, null, 2));
      await client.chat.postMessage({ channel: event.user, text: "[自動応答]質問を受け付けました。返信をお待ちください。追記事項がある場合は続けて送信してください。" });
    }
  } else if (event["channel_type"] === "channel" || event["channel_type"] == "group") {
    // チャンネルへの書き込み

    // チャンネルの一致を確認する (質問対応チャンネルかどうか確認)
    if (event["channel"] !== channel_id) {
      return; // 質問チャンネルではない場合は無視
    }
    // スレッドに書き込んだメッセージかつ、Botが投下したメッセージのスレッドの場合
    if (event["thread_ts"] && event["parent_user_id"] == bot_id) {
      // 質問者のuser_idを取得する。質問していない場合はnull
      const user = Object.keys(ts_user).filter((key) => { return ts_user[key].ts == event["thread_ts"] });
      logger.debug("DMにRedirect: " + user[0]);
      if (!user[0] || !ts_user[user[0]] || !ts_user[user[0]].in_progress) {
        // 質問者のuser_idがない場合, 質問応対(in_progress)をしていない場合
        return;
      }
      // 質問者にメッセージをリダイレクト && 送信済を表すリアクション
      await redirectMessage({ client }, user[0], event.text, null);
      await checkReaction({ logger, client, event, say });
    }
  }
});

// リアクション追加時 (対応開始、対応終了、Botが投下したメッセージの削除)
app.event("reaction_added", async ({ logger, client, event, say }) => {
  logger.debug("reaction_added event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
  //　Botが投下したメッセージの削除機能
  if (event.reaction === "delete" && event.item.channel === channel_id) {
    await client.chat.delete({
      channel: channel_id,
      ts: event.item.ts
    });
    return;
  }
  // 質問対応中である場合、ユーザを取得
  const user = Object.keys(ts_user).filter((key) => { return ts_user[key].ts == event.item.ts });

  if (user[0]) {
    if (event.reaction === "対応中" && ts_user[user[0]]) {
      // 質問に対して対応中をつけた場合（対応開始)
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel,
        text: "[対応開始]以降のスレッドは質問者に転送されます。対応が終了した場合、:対応済2:をスレッドトップのメッセージにつけてください。メッセージの編集機能は質問者側に反映されないので注意してください。",
        thread_ts: ts_user[user[0]].ts
      });
      ts_user[user[0]].in_progress = true;
    }
    if (event.reaction === "対応済2" && ts_user[user[0]]) {
      // 対応中の質問に対して、対応済2をつけた場合(対応終了)
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel, text: "[対応終了]以降のスレッドは転送されません。", thread_ts: ts_user[user[0]].ts
      });
      // userに対して対応終了を通知する
      await client.chat.postMessage({ channel: user[0], text: "[自動応答]質問対応を終了しました。以降のメッセージは新規の質問対応として処理されます。" });
      //ts_user[user[0]].in_progress = false;
      delete ts_user[user[0]];
    }
  }
});

// reaction削除
app.event("reaction_removed", async ({ logger, event, say }) => {
  logger.debug("reaction_removed event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
});

// workflow steps
app.action({ type: 'workflow_step_edit' }, async ({ body, ack, client, logger }) => {
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
        callback_id: "qabot_workflow",
        blocks: [
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
app.view("qabot_workflow", async ({ logger, client, view, body, ack }) => {
  logger.debug("qabot_workflow view : " + JSON.stringify(body, null, 2) + "\n");
  await ack();
  let workflowEditId = body.workflow_step.workflow_step_edit_id;
  let from = view.state.values.qabot_input_questioner.from;
  let type = view.state.values.qabot_input_qtype.q_type;
  let question = view.state.values.qabot_input_values.question;

  await client.workflows.updateStep({
    workflow_step_edit_id: workflowEditId,
    inputs: {
      from: { value: (from || "") },
      type: { value: (type || "") },
      question: { value: (question || "") }
    },
    outputs: [
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
      name: inputs.from.value,
      question: inputs.question.value,
      type: inputs.question.type
    }
  });
  // ユーザ追加処理
  const user = inputs.from.value.value.match(/<@([0-9a-zA-Z]*)>/)[1];
  const question_text = `[${inputs.type.value.value}]${inputs.question.value.value}`;
  // もしすでに質問対応を行っていた場合
  if (ts_user[user]) {
    const dm_info = ts_user[event.user]
    await redirectMessage({ client }, dm_info.channel, question_text, dm_info.ts);
    await client.chat.postMessage({
      channel: user, text: question_text
    });
    return;
  }
  const pre_text = `<@${user}>さんが質問を投稿しました\n`;
  const suf_text = "\n\n責任者は" + `<@${choiseOne()}>` + "さんに割り当てられました。\nスレッドを介してやりとりするには :対応中: でリアクションしてください。";
  const result = await client.chat.postMessage({ channel: channel_id, text: pre_text + question_text + suf_text, blocks: generateQuestionBlock(pre_text, question_text, suf_text) });
  //logger.debug(question_text);
  // 質問受付リストに登録
  ts_user[user] = { user: user, ts: result.ts, channel: channel_id, in_progress: false };
  //logeer.debug(JSON.stringify(result, null, 2));
  await client.chat.postMessage({
    channel: user, text: question_text
  });
  await client.chat.postMessage({ channel: user, text: "[自動応答]質問を受け付けました。返信をお待ちください。追記事項がある場合は続けて追記してください。" });
});

// Utility to post a message using response_url
const axios = require('axios');
function postViaResponseUrl(responseUrl, response) {
  return axios.post(responseUrl, response);
}

// 重みつきランダム抽出
function ratioChoise(id_list) {
  const totalWeight = id_list.reduce((p, c) => { return { weight: p.weight + c.weight } }).weight;
  return {
    pick() {
      const r = Math.random() * totalWeight;
      let s = 0.0;
      for (const l of id_list) {
        s += l.weight;
        if (r < s) {
          return l;
        }
      }
    }
  }
}

// stateに合わせて一人ピックアップする
function choiseOne() {
  if (state === "RANDOM") {
    return membersList[Math.floor(Math.random() * membersList.length)].id;
  } else if (state === "ROUNDROBIN") {
    if (rbcounter == membersList.length)
      rbcounter = 0;
    return membersList[rbcounter++].id;
  } else if (state === "RATIO") {
    return ratioChoise(membersList).pick().id;
  }
}

// 質問内容 Block Kit
function generateQuestionBlock(prefix_text, main_text, suffix_text) {
  return [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": prefix_text
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": main_text
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": suffix_text
      }
    }
  ];
}

// リダイレクト機能
async function redirectMessage({ client }, channel, text, ts) {
  // tsがある時、スレッドに投稿する。
  if (ts) {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": text,
      "thread_ts": ts
    });
    return result;
  } else {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": text
    });
    return result;
  }
}

// Botの送信済リアクション
async function checkReaction({ logger, client, event, say }) {
  const result = await client.reactions.add({
    "channel": event.channel,
    "name": "white_check_mark",
    "timestamp": event.event_ts
  });
  return result;
}

// チャンネルメンバーを取得する。
async function getMembers(channel_id, client) {
  const param = {
    token: process.env.SLACK_BOT_TOKEN,
    channel: channel_id,
    limit: 50
  }
  let members = [];
  function pageLoaded(res) {
    res.members.forEach(m => {
      if (m !== bot_id) // Botは弾く
        members.push({ id: m, weight: 1 });
    });
    if (res.response_metadata && res.response_metadata.next_cursor && res.response_metadata.next_cursor !== '') {
      param.cursor = res.response_metadata.next_cursor;
      return client.conversations.member(param).then(pageLoaded);
    }
    return members;
  }
  return client.conversations.members(param).then(pageLoaded);
}

// ejsの導入でhtmlファイルを扱う
receiver.app.set("view engine", "ejs");

// アプリ動作確認用
receiver.app.get("/", (_req, res) => {
  res.send("Your Bolt ⚡️ App is running!");
});

// メンバー情報を受け渡す(Slack user_idしか持ち得ないので、直接害はないはず、、、）
receiver.app.get("/getConfig", (_req, res) => {
  res.json({
    bot_id: "xxxxxxxx",
    channel_id: "xxxxxxxx",
    members: membersList
  });
});
// コンフィグへのページ
receiver.app.get("/config", (_req, res) => {
  res.render("./config.ejs");
});
// ファイル受取 (Github bolt-js Issue #516より、expressを追加)
receiver.app.post("/setConfig", express.json(), (req, res) => {
  try {
    console.log(req.body);
    if (req.body.channel_id !== channel_id || req.body.bot_id !== bot_id) {
      res.send("NG: channel_id or bod_id is failed.");
      console.log("NG");
      return;
    }
    members = req.body.members;
    res.send("OK");
  } catch (e) {
    console.log(e);
  }
});


// アプリの起動
(async () => {
  // 初期化
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Bolt app is running!");
  // 起動メッセージ
  // const result = await app.client.chat.postMessage({ token: process.env.SLACK_BOT_TOKEN, channel: channel_id, text: "QABotが起動しました" });
  // メンバーリスト取得
  membersList = await getMembers(channel_id, app.client);
  // ラウンドロピンの初期値を指定
  rbcounter = Math.floor(Math.random() * membersList.length);
  console.log(JSON.stringify(membersList));
})();
