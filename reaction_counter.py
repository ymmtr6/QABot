# coding: utf-8
import slack
import json
import time
import re
import datetime
import os


class ReactionCounter(object):

    def __init__(self, token):
        self.token = token
        self.client = slack.WebClient(token=token)
        self.today = datetime.datetime.combine(
            datetime.date.today(), datetime.time())

    def isToday(self, ts) -> bool:
        message_dt = datetime.datetime.fromtimestamp(float(ts))
        delta = message_dt - self.today
        return delta.days == 0

    def get_messages(self, channel_id):
        messages = []
        cursor = None
        while(True):
            time.sleep(1)
            response = self.client.conversations_history(
                channel=channel_id, cursor=cursor)
            messages.extend(response["messages"])
            cursor = response.get("response_metadata", {}).get(
                "next_cursor", None)
            if cursor is None:
                break
        return messages

    def count_reaction(self, messages=[]):
        rcount = {}
        tcount = {}
        for message in messages:
            reactions = message.get("reactions", {})
            for reaction in reactions:
                if reaction["name"] == "対応中":
                    for user in reaction["users"]:
                        if user in rcount:
                            rcount[user] += 1
                        else:
                            rcount[user] = 1
                        if user in tcount:
                            if self.isToday(message["ts"]):
                                tcount[user] += 1
                        else:
                            if self.isToday(message["ts"]):
                                tcount[user] = 1
                            else:
                                tcount[user] = 0
                    break
        rcount = sorted(rcount.items(), key=lambda x: x[1], reverse=True)
        return rcount, tcount

    def strp(self, rcount=[], tcount=[]):
        num = 0
        today = 0
        output = ""  # "合計(本日増) アカウント名\n"
        for slackid, c in rcount:
            res = self.client.users_info(user=slackid)
            if res["ok"]:
                # output.append( (res["user"]["real_name"], c) )
                output += "{:3d}回(+{:d}回) {}\n".format(c, tcount[slackid],
                                                       res["user"]["real_name"])
                num += c
                today += tcount[slackid]
            else:
                output += "{:3d}回(+{:d}回) {}\n".format(c, tcount[slackid],
                                                       res["user"]["real_name"])
                num += c
                today += tcount[slackid]
        dt_now = datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=+9)))
        output = "{} 累計{}回(本日{}回)\n".format(dt_now, num, today) + output
        return output

    def write_file(self, output_str, file_path):
        with open(file_path, "w") as f:
            f.write(output_str)

    def run(self, channel_id, output_filepath):
        messages = self.get_messages(channel_id)
        print(len(messages))
        rcount, tcount = self.count_reaction(messages)
        output = rc.strp(rcount, tcount)
        print(output)
        rc.write_file(output, output_filepath)


if __name__ == "__main__":
    token = os.environ.get("SLACK_BOT_TOKEN")
    channels_file = "./config/channels.json"
    channels = [
    ]
    with open(channels_file) as f:
        channels = json.load(f)
    rc = ReactionCounter(token=token)
    for channel in channels:
        rc.run(channel, "./config/ranking-{}.json".format(channel))
