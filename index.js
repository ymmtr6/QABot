// `cp _env .env` then modify it
// See https://github.com/motdotla/dotenv
const config = require("dotenv").config().parsed;
// Overwrite env variables anyways
for (const k in config) {
  process.env[k] = config[k];
}

const { LogLevel } = require("@slack/logger");
const logLevel = process.env.SLACK_LOG_LEVEL || LogLevel.DEBUG;

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

const channel_id = process.env.CHANNEL_ID || "CRAQA0GKH";
const bot_id = process.env.BOT_ID || "W018V7A8RND";
const ts_user = {}
let membersList = []
let rbcounter = 0;
let state = "ROUNDROBIN" // ROUNDROBIN, RANDOM, RATIO

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
app.event("app_mention", async ({ logger, client, event, say }) => {
  logger.debug("app_mention event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
  if (~event.text.indexOf("leave")) {
    const leave = await client.conversations.leave({
      "channel": event.channel
    });
    logger.debug("leabe result:\n\n" + JSON.stringify(leave, null, 2) + "\n");
    return leave;
  }
  // 以下はchannel_idの一致が必要なので飛ばす
  if (event.channel !== channel_id) {
    return
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
      text: `LB: ${state}\nAnswers: ` + JSON.stringify(membersList, null, 2)
    });
  } else if (~event.text.indexOf("random")) {
    state = "RANDOM";
    await client.chat.postMessage({
      channel: channel_id,
      text: "pickup stateをRANDOMに設定します。"
    });
  } else if (~event.text.indexOf("roundrobin")) {
    state = "ROUNDROBIN";
    await client.chat.postMessage({
      channel: channel_id,
      text: "pickup stateをROUNDROBINに設定します"
    })
  } else if (~event.text.indexOf("ratio")) {
    state = "RATIO";
    await client.chat.postMessage({
      channel: channel_id,
      text: "pickup stateをRATIOに設定します"
    })
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
      + "\n[state] 現在の状態を表示します"
      + "\n[random] pickup stateをRANDOMに設定します"
      + "\n[roundrobin] pickup stateをROUNDROBINに設定します"
      + "\n[ratio] pickup stateをRATIOに設定します";
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
      // BotにDMを送信している場合、返事を行う。
      logger.debug("スレッドにRedirect");
      const dm_info = ts_user[event.user]
      await redirectMessage({ client }, dm_info.channel, event.text, dm_info.ts);
    } else {
      // メッセージが登録されていない場合（初質問)
      // ここでchannel_idを固定している。要再検討
      logger.debug("チャンネルにRedirect(質問初投稿)");
      const pre_text = `<@${event.user}>さんが質問を投稿しました\n`;
      const suf_text = "\n\n責任者は" + `<@${choiseOne()}>` + "さんに割り当てられました。\nスレッドを介してやりとりするには :対応中: でリアクションしてください。";
      const result = await client.chat.postMessage({ channel: channel_id, text: pre_text + event.text + suf_text, blocks: generateQuestionBlock(pre_text, event.text, suf_text) });
      ts_user[event.user] = { user: event.user, ts: result.ts, channel: channel_id, in_progress: false }
      //logeer.debug(JSON.stringify(result, null, 2));
      await client.chat.postMessage({ channel: event.user, text: "[自動応答]質問を受け付けました。返信をお待ちください。追記事項がある場合はこのメッセージに続けて送信してください。" })
    }
  } else if (event["channel_type"] === "channel" || event["channel_type"] == "group") {
    // チャンネルの一致を確認する
    if (event["channel"] !== channel_id) {
      return;
    }
    // channel (private 含む)
    if (event["thread_ts"] && event["parent_user_id"] == bot_id) {
      //logger.debug("DMにRedirect: " + bot_id);
      const user = Object.keys(ts_user).filter((key) => { return ts_user[key].ts == event["thread_ts"] });
      logger.debug("DMにRedirect: " + user[0]);
      if (!user[0] || !ts_user[user[0]] || !ts_user[user[0]].in_progress) {
        return;
      }
      await redirectMessage({ client }, user[0], event.text, null);
      await checkReaction({ logger, client, event, say });
    } else {
      // スレッドに登録されているものは反応する。
      // await checkReaction({ logger, client, event, say });
    }
  }
});

app.event("reaction_added", async ({ logger, client, event, say }) => {
  logger.debug("reaction_added event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
  const user = Object.keys(ts_user).filter((key) => { return ts_user[key].ts == event.item.ts });
  if (event.reaction === "delete" && event.item.channel === channel_id) {
    await client.chat.delete({
      channel: channel_id,
      ts: event.item.ts
    });
    return;
  }
  if (user[0]) {
    if (event.reaction === "対応中" && ts_user[user[0]]) {
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel,
        text: "[対応開始]以降のスレッドは質問者に転送されます。対応が終了した場合、:対応済2:をスレッドトップのメッセージにつけてください。メッセージの編集機能は質問者側に反映されないので注意してください。",
        thread_ts: ts_user[user[0]].ts
      });
      ts_user[user[0]].in_progress = true;
    }
    if (event.reaction === "対応済2" && ts_user[user[0]]) {
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel, text: "[対応終了]以降のスレッドは転送されません。", thread_ts: ts_user[user[0]].ts
      });
      await client.chat.postMessage({ channel: user[0], text: "[自動応答]質問対応を終了しました。以降のメッセージは新規の質問対応として処理されます。" });
      //ts_user[user[0]].in_progress = false;
      delete ts_user[user[0]];
    }
  }
});

app.event("reaction_removed", async ({ logger, event, say }) => {
  logger.debug("reaction_removed event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");
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

// 質問内容をblockで表現
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

// リダイレクト機能を追加
async function redirectMessage({ client }, channel, text, ts) {
  // tsがある時、スレッドに投稿する。
  if (ts) {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": text,
      "thread_ts": ts
    });
  } else {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": text
    });
  }
}

// Botの確認済リアクション
async function checkReaction({ logger, client, event, say }) {
  const result = await client.reactions.add({
    "channel": event.channel,
    "name": "white_check_mark",
    "timestamp": event.event_ts
  });
  return result;
}

// チャンネルメンバーを設定する。
async function getMembers(channel_id, client) {
  const param = {
    token: process.env.SLACK_BOT_TOKEN,
    channel: channel_id,
    limit: 50
  }
  let members = [];
  function pageLoaded(res) {
    res.members.forEach(m => {
      if (m !== bot_id)
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

receiver.app.get("/", (_req, res) => {
  res.send("Your Bolt ⚡️ App is running!");
});

(async () => {
  // 初期化
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Bolt app is running!");
  // 起動メッセージ
  const result = await app.client.chat.postMessage({ token: process.env.SLACK_BOT_TOKEN, channel: channel_id, text: "QABotが起動しました" });
  // メンバーリスト取得
  membersList = await getMembers(channel_id, app.client);
  // ラウンドロピンの初期値を指定
  rbcounter = Math.floor(Math.random() * membersList.length);
  console.log(JSON.stringify(membersList));
})();
