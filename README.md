# QABot

Slackのメッセージプロキシ（DMースレッド）。

## RUN

1. Slack AppでAppの初期設定を行い，トークンを取得する

2. 環境変数.envにTokenなどを設定する

```
cd QABot
cp _env .env
nano .env
```

3. 実行

ローカルのnodejsで動作させる場合
```
npm i
npm run local
```

docker-composeで動作させる場合
```
docker-compose up -d
```

## SLACK APPで必要な初期設定

1. アプリを作成
2. ショートカット`/qabot_load`を作成（チャンネルに所属しているメンバーを引数の質問先チャンネルIDに質問許可）
3. モーダル`qabot_v2_modal`を作成(質問UI)
4. OAuth & Permissionで必要な権限を登録

```
app_mentions:read
View messages that directly mention @qabot in conversations that the app is in

channels:history
View messages and other content in public channels that QABot has been added to

channels:read
View basic information about public channels in a workspace

chat:write
Send messages as @qabot

commands
Add shortcuts and/or slash commands that people can use

files:read
View files shared in channels and conversations that QABot has been added to

files:write
Upload, edit, and delete files as QABot

groups:history
View messages and other content in private channels that QABot has been added to

groups:read
View basic information about private channels that QABot has been added to

groups:write
Manage private channels that QABot has been added to and create new ones

im:history
View messages and other content in direct messages that QABot has been added to

im:read
View basic information about direct messages that QABot has been added to

im:write
Start direct messages with people

mpim:history
View messages and other content in group direct messages that QABot has been added to

mpim:read
View basic information about group direct messages that QABot has been added to

mpim:write
Start group direct messages with people

reactions:read
View emoji reactions and their associated content in channels and conversations that QABot has been added to

reactions:write
Add and edit emoji reactions

users:read
View people in a workspace

users:read.email
View email addresses of people in a workspace

```

5. Event Subscriptionでbot_eventを設定

```
app_mention
Subscribe to only the message events that mention your app or bot

app_mentions:read

message.groups
A message was posted to a private channel

groups:history

message.im
A message was posted in a direct message channel

im:history

message.mpim
A message was posted in a multiparty direct message channel

mpim:history

reaction_added
A member has added an emoji reaction to an item

reactions:read

reaction_removed
A member removed an emoji reaction

reactions:read

```

## ファイル階層

```
$ tree -L 1
.
├── Dockerfile
├── LICENSE.txt
├── README.md
├── README_docker_ops.md # bolt-starterのREADME
├── README_ja.md # bolt-starterのREADME
├── _env # .envファイルのテンプレート
├── config　# コンフィグの保存先
├── docker-compose.yml
├── index.js # main
├── node_modules
├── package-lock.json
├── package.json
├── reaction_counter.py # リアクション計上スクリプト
├── requirements.txt # 
├── tmp # ファイル転送用の保管場所(デバッグ用)
└── views # deprecated(socketモード実装に伴い不要)
```

### config

configディレクトリには，QABotのStateを保存する．

* allow_channels.json
ユーザIDに対して質問先チャンネルのリストを保存

* channels.json
質問先のチャンネルIDを保存

* ts_user.json
質問対応中のユーザIDとチャンネルIDの組み合わせを保存

初回起動時に読み込み，変更が生じると上書きされる．
そのため，何かバグが発生した場合はアプリを停止→configを編集→アプリを再起動すると復旧可能

docker-composeでの起動の場合
```
$ docker-compose stop && docker-compose rm -f
$ nano config/ts-user.json
$ docker-compose up -d
```

## 各種機能

### メッセージリダイレクト機能

スレッドーDM間のメッセージをリダイレクトする機能．リアクションによって操作する．

### ステータス表示機能

Botにメンションを送ることで，現在未対応の質問を表示する

### ランキング機能

対応回数ランキングを表示する．QABotでは，対応するチャンネルのテキストファイルを出力するだけの機能である．テキストは外部のスクリプトによって更新している．（削除検討中）

### フィードバック機能

質問終了後，学生からの対応評価のアンケートをとる．1〜5段階で示されており，結果はスタンプによって表示する

## 講義登録

* 質問対応チャンネルと講義チャンネルが必要．

「アプリの追加」で両方のチャンネルメンバーにQABotを追加する．

1. 質問対応チャンネルでは，QABotにメンションを送り，質問対応チャンネルとしての登録を行う．チャンネルIDが表示されるので，控えておく．

2. 講義チャンネルでは，チャンネルIDと講義名を指定し，コマンドを実行することで，メンバーに質問許可を出す．

## 質問をする(学生側)

1. ショートカットから，*QABotへ質問する* を選択し，講義，質問内容等をUIにしたがって入力する
2. QABotからDMがやってくるので，質問終了まではDMでやりとりする

## 質問を受ける（教員・TA側）

* 質問対応はスタンプの反映等の問題から，PC(アプリ，WEB)で行うことを推奨する．

1. 受けた質問がメッセージとして対応チャンネルに通知される．
2. 対応する質問に :対応中2: でリアクションすると，スレッドが生える．以降スレッドでやりとりが可能になる．
3. やりとりを終える場合は， :対応済: でリアクションする．


## 変更履歴

* 2020/09/09 v2。責任者割当機能をオミットし、複数講義（複数の質問チャンネル）に対応。

* 2021/02/07 Slack Blot v3 にアップデートしSocketモードに対応．
