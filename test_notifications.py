"""Offline checks: uv run python -m unittest test_notifications"""

import unittest
from functools import partial
from unittest.mock import Mock, patch

import main

FORM_URL = "https://docs.google.com/forms/d/e/test/viewform"
SUBMIT_URL = "https://docs.google.com/forms/d/e/test/formResponse"


class NotificationTests(unittest.TestCase):
    def test_workflow_notifications(self):
        for failed_stage in (None, "questions", "answers", "submission"):
            with self.subTest(failed_stage=failed_stage), \
                 patch.object(main, "get_questions_from_form", return_value={}) as questions, \
                 patch.object(main, "answer_questions", return_value={}) as answers, \
                 patch.object(main, "answer_google_form") as submission, \
                 patch.object(main, "notify") as notify, \
                 patch.object(main.subprocess, "run") as browser:
                if failed_stage:
                    {"questions": questions, "answers": answers, "submission": submission}[failed_stage].side_effect = ValueError("test")
                main.process_form(FORM_URL)
                self.assertEqual(
                    [call.args[0] for call in notify.call_args_list],
                    ["Google Form found", "Google Form failed" if failed_stage else "Google Form submitted"],
                )
                self.assertEqual(browser.call_count, int(failed_stage is not None))

    def test_notification_failure_does_not_raise(self):
        with patch.object(main, "Notify", side_effect=RuntimeError("No desktop")):
            main.notify("Test", "Test")
        with patch.object(main, "Notify") as notifier:
            main.notify("Test", "Test")
            notifier.return_value.send.assert_called_once_with(block=False)
            notifier.return_value.send.side_effect = RuntimeError("No bus")
            main.notify("Test", "Test")

    def test_ai_error_reaches_workflow(self):
        with patch.object(main, "OpenAI", side_effect=RuntimeError("API unavailable")):
            with self.assertRaises(RuntimeError):
                main.ai_answer("Test question")

    def test_empty_ai_answer_fails_without_retrying_forever(self):
        with patch.object(main, "OpenAI") as client:
            create = client.return_value.chat.completions.create
            create.return_value.choices = [Mock(message=Mock(content=""))]
            with self.assertRaisesRegex(ValueError, "empty answer"):
                main.ai_answer("Test question")
            create.assert_called_once()
            self.assertEqual(client.call_args.kwargs["timeout"], 30)

    def test_watcher_continues_after_success_and_failure(self):
        with (
            patch.object(main, "get_google_form_url", side_effect=[None, FORM_URL, FORM_URL, KeyboardInterrupt]),
            patch.object(main, "get_questions_from_form", return_value={}),
            patch.object(main, "answer_questions", return_value={}),
            patch.object(main, "answer_google_form", side_effect=[ValueError("Rejected"), None]) as submit,
            patch.object(main, "notify") as notify,
            patch.object(main.subprocess, "run", side_effect=OSError("No desktop")),
        ):
            with self.assertRaises(KeyboardInterrupt):
                main.run()
            self.assertEqual(submit.call_count, 2)
            self.assertEqual(
                [call.args[0] for call in notify.call_args_list],
                ["Google Form found", "Google Form failed", "Google Form found", "Google Form submitted"],
            )

    def test_poll_errors_back_off_and_notify_once_per_outage(self):
        with (
            patch.object(main, "get_google_form_url", side_effect=[OSError(), OSError(), None, OSError(), KeyboardInterrupt]),
            patch.object(main, "notify") as notify,
            patch.object(main.time, "sleep") as sleep,
        ):
            with self.assertRaises(KeyboardInterrupt):
                main.run()
            self.assertEqual(notify.call_count, 2)
            self.assertEqual(sleep.call_count, 3)
            sleep.assert_called_with(5)

    def test_submission_requires_confirmation(self):
        for url, html, accepted in (
            (SUBMIT_URL, '<div class="vHW8K">Your response has been recorded.</div>', True),
            (SUBMIT_URL, '<div class="freebirdFormviewerViewResponseConfirmationMessage">תודה</div>', True),
            ("https://accounts.google.com/login", '<div class="vHW8K">Sign in</div>', False),
            (SUBMIT_URL, '<form>Missing required answers</form>', False),
            (SUBMIT_URL, '<div class="vHW8K"></div>', False),
        ):
            with (
                self.subTest(url=url, html=html),
                patch.object(main.browser_cookie3, "chromium", return_value={}),
                patch.object(main.requests, "post", return_value=Mock(url=url, text=html)) as post,
            ):
                if accepted:
                    main.answer_google_form(FORM_URL, {"entry.1": "test"})
                else:
                    with self.assertRaisesRegex(ValueError, "did not confirm"):
                        main.answer_google_form(FORM_URL, {"entry.1": "test"})
                self.assertEqual(post.call_args.args[0], SUBMIT_URL)
                self.assertEqual(post.call_args.kwargs["timeout"], (5, 30))

    def test_form_read_uses_cookies_and_rejects_empty_or_login_pages(self):
        params = '[[1,"Question",null,0,[[123]],null]]'
        html = f'<div jsmodel="CP1oW" data-params=\'{params}\'></div>'
        # Google prefixes its question data with "%.@." and omits the outer [.
        html = html.replace(params, "%.@." + params[1:])
        for url, page, accepted in (
            (FORM_URL, html, True),
            (FORM_URL, "<html>Form closed</html>", False),
            ("https://accounts.google.com/login", html, False),
        ):
            with (
                self.subTest(url=url, page=page),
                patch.object(main.browser_cookie3, "chromium", return_value={"session": "test"}),
                patch.object(main.requests, "get", return_value=Mock(url=url, text=page)) as get,
            ):
                if accepted:
                    self.assertEqual(main.get_questions_from_form(FORM_URL), {"entry.123": "Question"})
                else:
                    with self.assertRaises(ValueError):
                        main.get_questions_from_form(FORM_URL)
                self.assertEqual(get.call_args.kwargs["cookies"], {"session": "test"})
                self.assertEqual(get.call_args.kwargs["timeout"], (5, 30))

    def test_http_errors_and_timeouts_propagate(self):
        for operation, method in (
            (partial(main.get_questions_from_form, FORM_URL), "get"),
            (partial(main.answer_google_form, FORM_URL, {}), "post"),
        ):
            with (
                self.subTest(method=method),
                patch.object(main.browser_cookie3, "chromium", return_value={}),
                patch.object(main.requests, method) as request,
            ):
                request.return_value.raise_for_status.side_effect = main.requests.HTTPError()
                with self.assertRaises(main.requests.HTTPError):
                    operation()
                request.side_effect = main.requests.Timeout()
                with self.assertRaises(main.requests.Timeout):
                    operation()

    def test_preview_url_and_unsafe_submission_targets(self):
        with (
            patch.object(main.browser_cookie3, "chromium", return_value={}),
            patch.object(main.requests, "post", return_value=Mock(
                url=SUBMIT_URL, text='<div class="vHW8K">Recorded</div>'
            )) as post,
        ):
            main.answer_google_form(FORM_URL.replace("viewform", "preview") + "?usp=sharing", {})
            self.assertEqual(post.call_args.args[0], SUBMIT_URL + "?usp=sharing")
            post.reset_mock()
            for url in ("https://evil.example/forms/viewform", "http://docs.google.com/forms/viewform", "https://docs.google.com/forms/unsupported"):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    main.answer_google_form(url, {})
            post.assert_not_called()

    def test_browser_timeout_is_handled(self):
        with (
            patch.object(main, "get_questions_from_form", side_effect=ValueError("Closed")),
            patch.object(main, "notify"),
            patch.object(main.subprocess, "run", side_effect=main.subprocess.TimeoutExpired("xdg-open", 10)),
        ):
            main.process_form(FORM_URL)

    def test_form_links_require_google_host(self):
        for text, expected in (
            (f"Registration: {FORM_URL}", FORM_URL),
            ("https://docs.google.com/forms.evil/viewform", None),
            ("https://docs.google.com.evil/forms/test", None),
            ("No link", None),
        ):
            with self.subTest(text=text), patch.object(main, "greenAPI") as api:
                api.receiving.receiveNotification.return_value.data = {
                    "receiptId": "test",
                    "body": {
                        "typeWebhook": "incomingMessageReceived",
                        "senderData": {"chatId": main.TENNIS_CHAT_ID},
                        "messageData": {"textMessageData": {"textMessage": text}},
                    },
                }
                self.assertEqual(main.get_google_form_url(), expected)
