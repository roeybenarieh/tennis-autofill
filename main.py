from pprint import pprint
import os
import subprocess
import sys
from pathlib import Path
import json
import re
import time
from urllib.parse import urlparse

import browser_cookie3
import requests
from bs4 import BeautifulSoup
from notifypy import Notify
from whatsapp_api_client_python import API

# got the ID using https://console.green-api.com/app/api/getChats
TENNIS_CHAT_ID = "120363178221541402@g.us"


CONFIG_FILE = (
    Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    / "tennis-autofiller"
    / "env"
)
REQUIRED_ENV = ("GREEN_API_ID_INSTANCE", "GREEN_API_TOKEN", "OPENROUTER_API_KEY")


def load_env_file(path: Path) -> None:
    # KEY=VALUE per line; blank lines and "#" comments ignored. Real env vars win.
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


load_env_file(CONFIG_FILE)

greenAPI = API.GreenAPI(
    idInstance=os.environ.get("GREEN_API_ID_INSTANCE", ""),
    apiTokenInstance=os.environ.get("GREEN_API_TOKEN", ""),
)


def notify(title: str, message: str):
    try:
        notification = Notify()
        notification.application_name = "Tennis autofill"
        notification.title = title
        notification.message = message
        notification.send(block=False)
    except Exception as error:
        print(f"Desktop notification failed: {type(error).__name__}", flush=True)


def get_google_form_url() -> str | None:
    # Green API HTTP queue: long-polls up to 5 s for the next incoming notification
    notification = greenAPI.receiving.receiveNotification().data
    if not notification:  # timeout, nothing queued
        return None
    greenAPI.receiving.deleteNotification(notification["receiptId"])
    body = notification["body"]
    if body.get("typeWebhook") != "incomingMessageReceived":
        return None
    if body["senderData"]["chatId"] != TENNIS_CHAT_ID:
        return None
    message = body["messageData"]
    text = (
        message.get("textMessageData", {}).get("textMessage")
        or message.get("extendedTextMessageData", {}).get("text")
        or ""
    )
    for match in re.finditer(r"https://[^\s<>]+", text):
        link = match.group(0).rstrip(".,!;)]}")
        url = urlparse(link)
        if url.hostname == "docs.google.com" and url.path.startswith("/forms/"):
            return link
    return None


# for more info: https://github.com/tienthanh214/googleform-autofill-and-submit
def answer_google_form(form_url: str, form_answers: dict[str, str]):
    url = urlparse(form_url)
    if url.scheme != "https" or url.netloc != "docs.google.com":
        raise ValueError("Expected a Google Forms URL")
    # recent links are /preview (or /viewform); submit goes to /formResponse
    for suffix in ("/preview", "/viewform"):
        if url.path.endswith(suffix):
            url = url._replace(path=url.path[: -len(suffix)] + "/formResponse")
    if not url.path.startswith("/forms/") or not url.path.endswith("/formResponse"):
        raise ValueError("Unsupported Google Forms URL")
    cookies = browser_cookie3.chromium(domain_name="google.com")
    res = requests.post(
        url.geturl(), data=form_answers, cookies=cookies, timeout=(5, 30)
    )
    res.raise_for_status()
    confirmation = BeautifulSoup(res.text, "html.parser").select_one(
        ".freebirdFormviewerViewResponseConfirmationMessage, .vHW8K"
    )
    if (
        urlparse(res.url).hostname != "docs.google.com"
        or confirmation is None
        or not confirmation.get_text(strip=True)
    ):
        raise ValueError("Google did not confirm the submission")


def get_questions_from_form(form_url: str) -> dict[str, str]:
    url = urlparse(form_url)
    if url.scheme != "https" or url.netloc != "docs.google.com" or not url.path.startswith("/forms/"):
        raise ValueError("Expected a Google Forms URL")
    # Fetch the HTML
    resp = requests.get(
        form_url, cookies=browser_cookie3.chromium(domain_name="google.com"), timeout=(5, 30)
    )
    resp.raise_for_status()
    if urlparse(resp.url).hostname != "docs.google.com":
        raise ValueError("Google redirected away from the form; check your login")
    soup = BeautifulSoup(resp.text, "html.parser")

    result = {}

    # Each question block is inside a div with jsmodel="CP1oW"
    for div in soup.find_all("div", {"jsmodel": "CP1oW"}):
        params = div.get("data-params")
        if not params:
            continue

        # convert data to python list
        cleaned = str(params)[4:]  # Remove prefix
        cleaned = f"[{cleaned}"  # add '[' for a valid Json
        question_data = json.loads(cleaned)  # Convert JSON to Python list

        # find the wanted data
        question = question_data[0][1]
        question_entry_num = question_data[0][4][0][0]

        # append result
        result[f"entry.{question_entry_num}"] = question

    if not result:
        raise ValueError("No questions found; the form may be closed or require login")
    return result


# @retry(tries=3, delay=1, backoff=2)
def ai_answer(question: str) -> str:
    from openai import OpenAI  # deferred: heavy import, only needed here

    while True:
        try:
            client = OpenAI(
                timeout=30.0,
                max_retries=1,
                base_url="https://openrouter.ai/api/v1",
                api_key=os.environ.get("OPENROUTER_API_KEY", ""),
            )

            completion = client.chat.completions.create(
                model="openai/gpt-oss-20b:free",
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant that answers Google form quesetions. "
                        "You are VERY concise, Your answers are VERY short and to the point(NEVER more than one clause). "
                        "In addition, you answer questions as a 20 years old human(e.g. if you are asked what is your famorite toy, you might say pazzles or action figures). "
                        "You answer ONLY in Hebrew.",
                    },
                    {"role": "user", "content": question},
                ],
            )
            result = completion.choices[0].message.content
            if not result or not result.strip():
                raise ValueError("The AI returned an empty answer")
            my_result = Path().cwd() / "hello.txt"
            my_result.write_text(result, encoding="utf-8")
            return result
        except Exception:
            raise


def answer_questions(questions: dict[str, str]) -> dict[str, str]:
    answers = {"emailAddress": "roey280404@gmail.com"}
    for entry, question in questions.items():
        if "שם" in question:
            answers[entry] = "רואי בן אריה"
        elif "דואר" in question:
            answers[entry] = "roey280404@gmail.com"
        elif "טלפון" in question:
            answers[entry] = "0585202050"
        elif "לבחור את השעה" in question:
            # must match one of the form's radio options exactly
            answers[entry] = "שעה 8:00 רמה 5+6+7"
        else:
            answers[entry] = ai_answer(question)

    return answers


def run():
    i = 0
    polling_failed = False
    while True:
        # each call long-polls ~5.6 s, so no extra sleep between polls
        try:
            form_url = get_google_form_url()
            polling_failed = False
        except Exception as e:
            print(f"Poll failed: {type(e).__name__}", flush=True)
            if not polling_failed:
                notify("Polling failed", f"Could not check for a form ({type(e).__name__}). Retrying.")
            polling_failed = True
            time.sleep(5)
            continue
        i += 1
        if not form_url:
            print(f"{time.strftime('%H:%M:%S')} poll {i}: nothing found", flush=True)
            continue
        process_form(form_url)


def process_form(form_url: str):
    print(f"found google form url: {form_url}")
    notify("Google Form found", "Preparing answers and submitting the form.")

    stage = "reading the form"
    try:
        qs = get_questions_from_form(form_url)
        stage = "generating answers"
        answers = answer_questions(qs)
        print("answers:")
        pprint(answers)

        stage = "submitting the form"
        answer_google_form(form_url=form_url, form_answers=answers)
    except Exception as error:
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        message = f"Error while {stage}: {detail}."
        if stage == "submitting the form":
            message += " Submission is unconfirmed; check before submitting again."
        print(message, flush=True)
        notify("Google Form failed", message)
        try:
            subprocess.run(["xdg-open", form_url], check=True, timeout=10)
        except (OSError, subprocess.SubprocessError) as browser_error:
            print(f"Could not open browser: {type(browser_error).__name__}", flush=True)
        return
    print("successfully answered the google form!")
    notify("Google Form submitted", "Successfully sent the form.")


if __name__ == "__main__":
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        sys.exit(f"Missing {', '.join(missing)}: set them in {CONFIG_FILE}")
    run()
