const config = require("dotenv").config().parsed;

// version明記
const version = "QABot version:1.3.5 (2021/02/05) \n"

// *************************
// 初期設定
// ************************
for (const k in config) {
  // 環境変数読み込み
  process.env[k] = config[k];
}

const fs = require("fs");
const { LogLevel } = require("@slack/logger");
const logLevel = process.env.SLACK_LOG_LEVEL || LogLevel.DEBUG;

const { App } = require("@slack/bolt");
const request = require("request");

// app オブジェクト生成
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  logLevel: logLevel,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// *****************************************
// 変数
// *****************************************

// bot id
let bot_id = process.env.BOT_ID;

// 質問対応チャンネルテーブル
// channel_table = { channel_id: name, ... }
let channel_table = [];

// アナウンス先テーブル（未使用）
// announce channel = { from(channel_id) : to(channel_id) , ...}
let announce_channel = {};

// 質問対応中テーブル
// ts_user = { user_id: { user: user_id, ts: ts, channel: channel_id, in_progress: false } }
let ts_user = {};

// 質問許可テーブル
// allow_channels = { user_id: {name: channel_name, id: channel_id}, ...};
let allow_channels = {};

// ======================================
//   メンション処理(初期設定，ステータス通知等)
// ====================================--

// メンション応答
app.event("app_mention", async ({ logger, client, event, say }) => {
  logger.debug("app_mention event payload:\n" + JSON.stringify(event, null, 2) + "\n");
  if (~event.text.indexOf("leave")) {
    // チャンネルから退室
    if (channel_table.indexOf(event.channel) !== -1) {
      channel_table = channel_table.filter(c => c !== event.channel);
      writeConfig("channels.json", channel_table);
      say(`channel_id(${event.channel})を質問受付チャンネルから削除しました。`);
    }
    const leave = await client.conversations.leave({
      "channel": event.channel
    });
  } else if (~event.text.indexOf("setup")) {
    // 質問受付チャンネルとして登録
    if (channel_table.indexOf(event.channel) !== -1) {
      say(`channel_id(${event.channel})は既に質問受付チャンネルとして登録されています。`);
    } else {
      say(`channel_id(${event.channel})を質問受付チャンネルとして登録しました。`);
      channel_table.push(event.channel);
      writeConfig("channels.json", channel_table);
    }
  } else if (~event.text.indexOf("announce")) {
    // アナウンスチャンネルとして登録(未実装)
    const inputs = event.text.split(" ");
    if (inputs[2] && channel_table.indexOf(inputs[2]) !== -1) {
      announce_channel[inputs[2]] = event.channel;
      say(`このチャンネル(${event.channel})を質問公開チャンネルとして登録します。`);
    } else if (inputs[2]) {
      say(`チャンネル${event.channel}は質問対応チャンネルとして登録されていません。`);
    } else {
      say(`USAGE : @QABot announce [channel_id]`);
    }
  } else if (~event.text.indexOf("status")) {
    // チャンネルでの対応中／未対応をリスト表示
    const channel_id = event.channel;
    // チャンネル登録者チェック
    if (channel_table.indexOf(channel_id) === -1) {
      return;
    }
    const users = Object.keys(ts_user).filter((key) => {
      return ts_user[key].channel === channel_id;
    });
    if (!users || users.length === 0) {
      say("未対応: 0人, 対応中: 0人");
      return;
    }
    const in_progress = Object.keys(ts_user).filter((key) => {
      return ts_user[key].channel === channel_id && ts_user[key].in_progress;
    });
    const non_progress = Object.keys(ts_user).filter((key) => {
      return ts_user[key].channel === channel_id && !ts_user[key].in_progress
    });
    let str = `未対応: ${non_progress.length}人, 対応中: ${in_progress.length}人\n`;
    non_progress.forEach((item) => {
      let ts = ts_user[item].ts
      ts = ts.replace(/\./, "");
      str += `https://kindai-info.slack.com/archives/${channel_id}/p${ts}\n`;
    });
    in_progress.forEach((item) => {
      let ts = ts_user[item].ts
      ts = ts.replace(/\./, "");
      str += `https://kindai-info.slack.com/archives/${channel_id}/p${ts}\n`;
    });
    say(str);
  } else if (~event.text.indexOf("ranking")) {
    // チャンネルの対応者リストを生成
    const channel_id = event.channel;
    if (channel_table.indexOf(channel_id) === -1) {
      return;
    }
    const log_file = `ranking-${channel_id}.json`;
    if (existsConfig(log_file)) {
      say("```" + fs.readFileSync("./config/" + log_file).toString() + "```");
    } else {
      logger.debug(log_file + " is not found.");
      return;
    }
  } else if (~event.text.indexOf("feedback")) {
    // フィードバックサンプルを表示
    await say({
      "blocks": generateFeedBack(event.channel, event.ts, "Feedback sample: フィードバックをお願いします(5点満点)")
    }).catch((e) => {
      logger.debug("message error: " + JSON.stringify(e, null, 2));
    });
  } else {
    // どれでもない場合
    const message = version
      + "\n `@QABot status` 未対応／未完了の質問一覧を出力"
      + "\n `@QABot ranking` 対応回数ランキングを出力";
    say(message);
  }
});

// *********************************************
// 　　メイン処理部（メッセージリダイレクト他）
// *********************************************

// メッセージハンドリング(DMやスレッドの投稿を分類する)
app.event("message", async ({ logger, client, event, say }) => {
  logger.debug("message event payload: \n" + JSON.stringify(event, null, 2) + "\n");

  if (event["channel_type"] === "im") {
    // DMへの投稿の場合
    await parseDM({ logger, client, event }).catch((e) => logger.debug(e));
  } else if (event["channel_type"] === "channel" || event["channel_type"] === "group") {
    // 質問チャンネルへの投稿の場合
    await parseThread({ logger, client, event }).catch((e) => logger.debug(e));
  }
});

// dm (DM->thread)
async function parseDM({ logger, client, event, say }) {
  if (!ts_user[event.user]) {
    //say("質問は講義チャンネルのワークフローから投稿してください。");
    return; //質問を受けていない場合、何もしない
  }

  // 対応中のユーザ情報を取得
  const dm_info = ts_user[event.user];

  //　redirect
  await redirectMessage({ client, logger }, dm_info.channel, event.text, dm_info.ts);
  if (event.files) {
    // ファイルが含まれている場合は，ファイル受信→送信処理
    await fileDownload({ logger, client, event }, dm_info.channel, dm_info.ts);
  }
  // 転送が終了したらリアクションで通知
  await sendReaction({ logger, client, event }, "white_check_mark");
}

// フィルダウンロード(&投稿)
async function fileDownload({ logger, client, event }, channel, ts) {
  for (f of event.files) {
    const file_url = f.url_private_download;
    const file_name = f.name;
    const title = f.title;
    const file_path = `tmp/${f.id}.${f.filetype}`;
    var options = {
      "uri": file_url,
      "headers": {
        "Authorization": "Bearer " + process.env.SLACK_BOT_TOKEN
      }
    };
    await FDRequest(options, file_path);

    if (ts) {
      const res = await client.files.upload({
        "channels": channel,
        "file": fs.createReadStream(file_path),
        "filename": file_name,
        "title": title,
        "thread_ts": ts
      });
    } else {
      const res = await client.files.upload({
        "channels": channel,
        "file": fs.createReadStream(file_path),
        "filename": file_name,
        "title": title
      });
    }
    try {
      fs.unlinkSync(file_path);
      logger.debug(`file ${file_path} deleted`);
    } catch (error) {
      logger.debug(error);
    }
  }
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
    // メッセージのリダイレクト
    await redirectMessage({ client, logger }, user[0], event.text, null);
    if (event.files) {
      // file transport
      await fileDownload({ logger, client, event }, user[0], null);
    }
    // 送信が完了したら，リアクションで完了通知
    await sendReaction({ logger, client, event }, "white_check_mark");
  }
}

// 送信済リアクション
async function sendReaction({ logger, client, event }, reaction_name) {
  const result = await client.reactions.add({
    "channel": event.channel,
    "name": reaction_name,
    "timestamp": event.event_ts
  }).catch((e) => logger.debug(e));
}

// リアクション追加を検知
app.event("reaction_added", async ({ logger, client, event }) => {
  logger.debug("reaction_added event payload:\n" + JSON.stringify(event, null, 2) + "\n");

  // Botが投稿した質問の場合は，ユーザ情報を保存しておく
  const user = Object.keys(ts_user).filter((key) => {
    return ts_user[key].ts === event.item.ts;
  });

  // 各リアクションに対応した処理を行う
  if (event.reaction === "完了") {
    // 完了はQABotが対応済を行う処理．
    await client.reactions.add({
      "channel": event.item.channel,
      "name": "対応済2",
      "timestamp": event.item.ts
    }).catch((e) => { logger.debug("対応済 :" + JSON.stringify(e, null, 2)) });
    if (ts_user[user[0]]) {
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel,
        text: "[対応終了] 以降のスレッドは転送されません。",
        thread_ts: ts_user[user[0]].ts
      }).catch((e) => logger.debug(e));
      await client.chat.postMessage({
        channel: user[0],
        text: "[対応終了]以降のやりとりは転送されません。"
      }).catch((e) => logger.debug(e));

      delete ts_user[user[0]];
      writeConfig("ts_user.json", ts_user);
      logger.debug("update_ts_user :" + JSON.stringify(ts_user, null, 2));
    } else {
      logger.debug("not found user: " + user[0]);
    }
    return;
  } else if (event.reaction === "delete" && event.user === "W015G22G970") {
    // 投稿の削除は owner の場合に有効
    await client.chat.delete({
      token: process.env.SLACK_BOT_TOKEN,
      channel: event.item.channel,
      ts: event.item.ts
    }).catch((e) => logger.debug(e));
    return;
  }
  if (user[0]) {
    // user情報がある -> 質問投稿に対する操作の場合
    if (event.reaction === "対応中" && !ts_user[user[0]].in_progress) {
      // 対応中 の場合は転送開始
      // STARTメッセージ
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel,
        text: "[対応開始]以降のスレッドは質問者に転送されます。対応が終了した場合、 :対応済2: をスレッドトップのメッセージにつけてください。",
        thread_ts: ts_user[user[0]].ts
      }).catch((e) => logger.debug(e));
      // フラグを入力し，コンフィグを更新
      ts_user[user[0]].in_progress = true;
      writeConfig("ts_user.json", ts_user);
    } else if (event.reaction === "対応済2" && ts_user[user[0]]) {
      // 対応済2　の場合は，転送終了
      // STOPメッセージ(教員・TA)
      await client.chat.postMessage({
        channel: ts_user[user[0]].channel,
        text: "[対応終了]以降のスレッドは転送されません。",
        thread_ts: ts_user[user[0]].ts
      }).catch((e) => logger.debug(e));
      // STOPメッセージ(学生)
      await client.chat.postMessage({
        channel: user[0],
        text: "[対応終了]以降のやりとりは転送されません。",
      }).catch((e) => logger.debug(e));
      // フィードバック処理
      await client.chat.postMessage({
        channel: user[0],
        text: "よろしければ、今回の対応のフィードバックをお願いします。(5点満点)",
        blocks: generateFeedBack(ts_user[user[0]].channel, ts_user[user[0]].ts, "よろしければ、今回の対応のフィードバックをお願いします。(5点満点)")
      }).catch((e) => logger.debug(e));
      // 対応中テーブルから削除 & コンフィグ更新
      delete ts_user[user[0]];
      writeConfig("ts_user.json", ts_user);
    }
  }
});

// appエラーをログに
app.error((error) => {
  console.error(JSON.stringify(error));
})

// reaction削除
app.event("reaction_removed", async ({ logger, client, event, say }) => {
  logger.debug("reaction_removed event payload:\n\n" + JSON.stringify(event, null, 2) + "\n");

  // 質問中ユーザを確認する
  const user = Object.keys(ts_user).filter((key) => { return ts_user[key].ts == event.item.ts });

  if (event.reaction === "対応中" && ts_user[user[0]]) {
    // 質問　かつ　対応中の取り消し

    // メッセージのリアクションを取得
    const messages = await client.conversations.replies({
      channel: event.item.channel,
      ts: event.item.ts
    });

    // TOPメッセージならば
    if (messages["messages"] && messages["messages"][0]) {
      // reactionを取得
      const reactions = messages["messages"][0]["reactions"];
      // 対応中のリアクションが他にされていないかを確認
      const progress = reactions.filter((item) => { return item.name === "対応中" });
      if (progress.length !== 0) {
        // 誰かが対応中の場合は対応しない
        return;
      }
    }
    // 対応中止処理
    await client.chat.postMessage({
      channel: ts_user[user[0]].channel,
      text: "[対応中止] :対応中: が取り消されました。スレッドの転送を中止します。再開するには、もう一度質問のトップメッセージに :対応中: でリアクションしてください。",
      thread_ts: ts_user[user[0]].ts
    }).catch((e) => logger.debug(e));

    // テーブル更新
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
      logger.debug(messages["messages"][0]);
      const user_id = messages["messages"][0]["text"].match(/<@([0-9a-zA-Z]*)>/)[1];
      const ts = messages["messages"][0]["ts"];
      const reactions = messages["messages"][0]["reactions"];
      const finish = reactions.filter((item) => { return item.name === "対応済2" });

      if (ts_user[user_id] || ts != event.item.ts || finish.length !== 0) {
        logger.debug(user_id);
        // すでにどこかで対応中の場合は無視
        return;
      }
      // user_idが発見できれば
      if (user_id) {
        // 対応中に変更
        ts_user[user_id] = { user: user_id, ts: event.item.ts, channel: event.item.channel, in_progress: true };
        writeConfig("ts_user.json", ts_user);

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
  }
});

// =======================
//   Feedback
// =======================

// フィードバック機能　action_id: feedback_button_X にマッチ
app.action(/feedback_button_*/, async ({ ack, action, respond, say, client, logger }) => {
  logger.debug("action feedback_button: \n" + JSON.stringify(action, null, 2));
  await ack();
  await respond("フィードバックを受け取りました。");

  // action_idの最後の一文字がフィードバックの点数
  const eval = action.action_id.split("_")[2];
  const value = JSON.parse(action.value);

  // reactionでフィードバックの結果を通知
  const reaction = await client.reactions.add({
    "channel": value.channel,
    "name": eval,
    "timestamp": value.ts
  }).catch((e) => logger.debug(JSON.stringify(e, null, 2)));

});

// ============================
//   質問許可を与える(初期設定)
// ============================

// 質問先設定
app.command("/qabot_load", async ({ logger, client, body, ack }) => {
  logger.debug("command qabot_load :" + JSON.stringify(body, null, 2));
  const args = body.text.split(" ");
  if (channel_table.indexOf(args[1]) !== -1 && args.length == 2) {
    await ack(`このチャンネルメンバーに${args[0]}へのチャンネル質問許可を与えます。`);
    logger.debug(`channel_name: ${args[0]}, channel_id: ${args[1]}`);
    const members = await getMembers({ client }, body.channel_id);
    logger.debug("members: " + JSON.stringify(members, null, 2));
    for (const m of members) {
      if (!allow_channels[m]) {
        allow_channels[m] = [];
      }
      //const user = Object.keys(ts_user).filter((key) => {
      //allow_channels[m].push({ name: args[0], id: args[1] });
      const lesson = allow_channels[m].filter((record) => {
        return (record.id === args[1]);
      });
      if (lesson.length === 0) {
        allow_channels[m].push({ name: args[0], id: args[1] });
      }
    }
    writeConfig("allow_channels.json", allow_channels);
    logger.debug("allow_channels :" + JSON.stringify(allow_channels, null, 2));
  } else {
    await ack(`ERROR: Invaild Input.`);
  }
});


// ================================
//   Modal　Create（質問入力パネル）
// ================================

// shortcut(質問モーダル)
app.shortcut("qabot_v2_modal", async ({ logger, client, body, ack }) => {
  await openModal({ logger, client, body, ack });
});

// modal callback
app.view("qabot_v2_modal_callback", async ({ logger, client, body, ack }) => {
  await handleViewSubmission({ logger, client, body, ack });
});


// modal open
async function openModal({ logger, client, body, ack }) {
  try {
    logger.debug("openModal: " + JSON.stringify(body, null, 2));
    const channels_options = generateChannelSelectBlock(body.user.id);
    logger.debug("options: " + JSON.stringify(channels_options, null, 2));
    const blocks = generateModalBlock(channels_options);
    logger.debug("blocks: " + JSON.stringify(blocks, null, 2));
    const res = await client.views.open(
      {
        "trigger_id": body.trigger_id,
        "view": {
          "type": "modal",
          "callback_id": "qabot_v2_modal_callback",
          "private_metadata": JSON.stringify(body),
          "title": {
            "type": "plain_text",
            "text": "QABotに質問する",
            "emoji": true
          },
          "submit": {
            "type": "plain_text",
            "text": "Submit",
            "emoji": true
          },
          "close": {
            "type": "plain_text",
            "text": "Cancel",
            "emoji": true
          },
          "blocks": blocks
        }
      }
    );
    logger.debug("views.open response: " + JSON.stringify(res, null, 2));
    await ack();
  } catch (e) {
    console.log(e.message);
    logger.error("views.open error: " + e.message);
    await ack(` :x: Failed to open modal due to *${e.code}* ...`);
  }
}

// モーダルの中身
function generateModalBlock(channels_options) {
  if (channels_options.length === 1) {
    return [
      {
        "type": "input",
        "block_id": "question_to",
        "element": {
          "type": "static_select",
          "action_id": "select",
          "placeholder": {
            "type": "plain_text",
            "text": "Select an item",
            "emoji": true
          },
          "options": channels_options,
          "initial_option": channels_options[0],
        },
        "label": {
          "type": "plain_text",
          "text": "講義を選択してください",
          "emoji": true
        }
      },
      {
        "type": "input",
        "block_id": "question_type",
        "element": {
          "type": "static_select",
          "action_id": "select",
          "placeholder": {
            "type": "plain_text",
            "text": "質問の種類を選択してください",
            "emoji": true
          },
          "options": [
            {
              "text": {
                "type": "plain_text",
                "text": "講義内容",
                "emoji": true
              },
              "value": "講義内容"
            },
            {
              "text": {
                "type": "plain_text",
                "text": "エラー／デバッグ",
                "emoji": true
              },
              "value": "エラー／デバッグ"
            },
            {
              "text": {
                "type": "plain_text",
                "text": "テスト／提出物",
                "emoji": true
              },
              "value": "テスト／提出物"
            },
            {
              "text": {
                "type": "plain_text",
                "text": "その他",
                "emoji": true
              },
              "value": "その他"
            }
          ]
        },
        "label": {
          "type": "plain_text",
          "text": "質問の種類",
          "emoji": true
        }
      },
      {
        "type": "input",
        "block_id": "question_value",
        "element": {
          "type": "plain_text_input",
          "action_id": "input",
          "multiline": true,
          "min_length": 10
        },
        "label": {
          "type": "plain_text",
          "text": "質問内容を具体的に入力してください",
          "emoji": true
        }
      }
    ];
  } else {
    return [
      {
        "type": "input",
        "block_id": "question_to",
        "element": {
          "type": "static_select",
          "action_id": "select",
          "placeholder": {
            "type": "plain_text",
            "text": "Select an item",
            "emoji": true
          },
          "options": channels_options,
        },
        "label": {
          "type": "plain_text",
          "text": "講義を選択してください",
          "emoji": true
        }
      },
      {
        "type": "input",
        "block_id": "question_type",
        "element": {
          "type": "static_select",
          "action_id": "select",
          "placeholder": {
            "type": "plain_text",
            "text": "質問の種類を選択してください",
            "emoji": true
          },
          "options": [
            {
              "text": {
                "type": "plain_text",
                "text": "講義内容",
                "emoji": true
              },
              "value": "講義内容"
            },
            {
              "text": {
                "type": "plain_text",
                "text": "エラー／デバッグ",
                "emoji": true
              },
              "value": "エラー／デバッグ"
            },
            {
              "text": {
                "type": "plain_text",
                "text": "テスト／提出物",
                "emoji": true
              },
              "value": "テスト／提出物"
            },
            {
              "text": {
                "type": "plain_text",
                "text": "その他",
                "emoji": true
              },
              "value": "その他"
            }
          ]
        },
        "label": {
          "type": "plain_text",
          "text": "質問の種類",
          "emoji": true
        }
      },
      {
        "type": "input",
        "block_id": "question_value",
        "element": {
          "type": "plain_text_input",
          "action_id": "input",
          "multiline": true,
          "min_length": 10
        },
        "label": {
          "type": "plain_text",
          "text": "質問内容を具体的に入力してください",
          "emoji": true
        }
      }
    ];
  }
}

// handle
async function handleViewSubmission({ logger, client, body, ack }) {
  //logger.debug("view_submission view payload: " + JSON.stringify(body, null, 2));

  const stateValue = body.view.state.values;
  const channel_id = stateValue["question_to"]["select"]["selected_option"].value;
  let question_type = stateValue["question_type"]["select"]["selected_option"].value;
  let question_text = stateValue["question_value"]["input"].value;
  const user = body.user.id;
  logger.debug(`channel_id:${channel_id}, type: ${question_type}, text: ${question_text}, user: ${user}`);

  await ack();

  // channel check
  if (channel_table.indexOf(channel_id) === -1) {
    logger.debug("no permition error");
    client.chat.postMessage({
      channel: user,
      text: "[自動応答]質問ができませんでした。(channel_id error: " + channel_id + ")"
    });
    return;
  }

  // すでに対応中の質問がある場合
  if (ts_user[user]) {
    const dm_info = ts_user[user];
    await client.chat.postMessage({
      channel: user,
      text: "[自動応答]新規の質問を受け付けたため、過去の質問対応は終了します。"
    }).catch((e) => { logger.debug(e) });
    await client.chat.postMessage({
      channel: dm_info.channel,
      text: "[自動応答]このユーザによる新規質問が投稿されたため、このスレッドは閉じられました。",
      thread_ts: dm_info.ts
    }).catch((e) => { logger.debug(e) });
    await client.reactions.add({
      "channel": dm_info.channel,
      "name": "対応済2",
      "timestamp": dm_info.ts
    }).catch((e) => { logger.debug("対応済 :" + JSON.stringify(e, null, 2)) });
    try {
      delete ts_user[user];
    } catch (e) {
      logger.debug(e);
    }
  }
  // 質問内容を投稿する
  let pre_text = `<@${user}>さんが質問を投稿しました\n`;
  if (question_type === "匿名") {
    pre_text = "";
  }
  if (question_type !== "その他" && question_type !== "匿名") {
    question_text = `[${question_type}] ` + question_text;
  }
  const suf_text = "\nスレッドを介してやりとりするには :対応中: でリアクションしてください。";
  const result = await client.chat.postMessage({
    channel: channel_id,
    text: pre_text + question_text + suf_text,
    blocks: generateQuestionBlock(pre_text, question_text, suf_text)
  }).catch((e) => logger.debug(e));
  // ts_userを上書き
  ts_user[user] = {
    user: user,
    ts: result.ts,
    channel: channel_id,
    in_progress: false
  }
  writeConfig("ts_user.json", ts_user);
  await client.chat.postMessage({
    channel: user,
    text: question_text + "\n[自動応答]質問を受け付けました。返信をお待ちください。\n追記事項がある場合はDM欄へ入力してください．ファイル転送も可能です．"
  }).catch((e) => logger.debug(e));

  // ここでWEBHOOKでアシスト処理へ情報を飛ばす．
}

// リダイレクト機能
async function redirectMessage({ client, logger }, channel, text, ts) {
  // 多分ts==nullならいい感じにしてくれるけど、条件分岐を設定しておく
  if (!text) {
    return;
  }
  if (ts) {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": text,
      "thread_ts": ts
    }).catch((e) => logger.debug(e));
    return result;
  } else {
    const result = await client.chat.postMessage({
      "channel": channel,
      "text": text
    }).catch((e) => logger.debug(e));
    return result;
  }
}

// 質問先チャンネル情報を作成
function generateChannelSelectBlock(user_id) {
  const options = [];
  if (!allow_channels[user_id]) {
    // 質問が許可されていない人はNO_DATA
    return [{
      "text": {
        "type": "plain_text",
        "text": "NO_DATA",
        "emoji": true
      },
      "value": "NO_DATA"
    }];
  }
  for (const obj of allow_channels[user_id]) {
    // 許可されているチャンネルを表示
    options.push({
      "text": {
        "type": "plain_text",
        "text": obj.name,
        "emoji": true
      },
      "value": obj.id
    });
  }
  if (options.length === 0) {
    // 許可されているチャンネルがなければ NO_DATA
    options.push({
      "text": {
        "type": "plain_text",
        "text": "NO_DATA",
        "emoji": true
      },
      "value": "NO_DATA"
    });
  }
  return options;
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

// フィードバックブロックの生成
function generateFeedBack(channel_id, ts, text) {
  const action_value = JSON.stringify({
    channel: channel_id,
    ts: ts
  });
  return [{
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": text
    },
    "block_id": "feedback_description"
  },
  {
    "type": "actions",
    "block_id": "feedback_button",
    "elements": [
      {
        "type": "button",
        "text": {
          "type": "plain_text",
          "emoji": true,
          "text": "1(悪い)"
        },
        "style": "danger",
        "value": action_value,
        "action_id": "feedback_button_one"
      },
      {
        "type": "button",
        "text": {
          "type": "plain_text",
          "emoji": true,
          "text": "2"
        },
        "value": action_value,
        "action_id": "feedback_button_two"
      },
      {
        "type": "button",
        "text": {
          "type": "plain_text",
          "emoji": true,
          "text": "3(普通)"
        },
        "value": action_value,
        "action_id": "feedback_button_three"
      },
      {
        "type": "button",
        "text": {
          "type": "plain_text",
          "emoji": true,
          "text": "4"
        },
        "value": action_value,
        "action_id": "feedback_button_four"
      },
      {
        "type": "button",
        "text": {
          "type": "plain_text",
          "emoji": true,
          "text": "5(良い)"
        },
        "style": "primary",
        "value": action_value,
        "action_id": "feedback_button_five"
      },
    ]
  }];
}

// =====================
//   Slack REST API Util
// =====================

// チャンネルに所属しているメンバーを取得
async function getMembers({ client }, channel_id) {
  const param = {
    "channel": channel_id,
    "limit": 100 // default
  };
  const members = [];
  function pageLoaded(res) {
    res.members.forEach(c => members.push(c));
    if (res.response_metadata && res.response_metadata.next_cursor && res.response_metadata.next_cursor !== '') {
      param.cursor = res.response_metadata.next_cursor;
      return client.conversations.members(param).then(pageLoaded);
    }
    return members;
  }
  return client.conversations.members(param).then(pageLoaded);
}

// bot idをtokenから取得する
async function setBotID(client) {
  const test = await client.auth.test({
    token: process.env.SLACK_BOT_TOKEN
  });
  console.log(test);
  bot_id = test.user_id;
}


// =======================
// 　　File I/O Util
// =======================


// config存在確認
function existsConfig(filename) {
  return fs.existsSync(`./config/${filename}`);
}

// config読み込み
function readConfig(filename) {
  return JSON.parse(fs.readFileSync(`./config/${filename}`));
}

// config書き出し
function writeConfig(filename, json_object) {
  fs.writeFileSync(`./config/${filename}`, JSON.stringify(json_object, null, 2));
}

// file download
async function FDRequest(param, file_path) {
  return new Promise((resolve, reject) => {
    let file = fs.createWriteStream(file_path);
    let stream = request.get(param)
      .pipe(file)
      .on("finish", () => {
        console.log(`file ${file_path} download complete`);
        resolve();
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

// =================
//   Main Func
// =================
(async () => {
  //await app.start(process.env.PORT || 3000);
  await app.start();
  console.log("Bolt app is runnning!");

  await setBotID(app.client);

  // コンフィグファイルの読み込み
  if (existsConfig("channels.json")) {
    console.log("channels load");
    channel_table = readConfig("channels.json");
  }
  if (existsConfig("ts_user.json")) {
    console.log("ts_user load");
    ts_user = readConfig("ts_user.json");
  }
  if (existsConfig("allow_channels.json")) {
    console.log("allow_channels load");
    allow_channels = readConfig("allow_channels.json");
  }
})();
