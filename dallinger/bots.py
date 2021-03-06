"""Bots."""

import json
import logging
import random
import uuid

from cached_property import cached_property
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from six.moves import urllib
import gevent
import requests

logger = logging.getLogger(__file__)


class BotBase(object):
    """A base class for bots that works with the built-in demos.

    This kind of bot uses Selenium to interact with the experiment
    using a real browser.
    """

    def __init__(self, URL, assignment_id='', worker_id='', participant_id='', hit_id=''):
        if not URL:
            return
        logger.info("Creating bot with URL: %s." % URL)
        self.URL = URL

        parts = urllib.parse.urlparse(URL)
        query = urllib.parse.parse_qs(parts.query)
        if not assignment_id:
            assignment_id = query.get('assignment_id', [''])[0]
        if not participant_id:
            participant_id = query.get('participant_id', [''])[0]
        if not hit_id:
            hit_id = query.get('hit_id', [''])[0]
        self.assignment_id = assignment_id
        if not worker_id:
            worker_id = query.get('worker_id', [''])[0]
        self.participant_id = participant_id
        self.hit_id = hit_id
        self.worker_id = worker_id
        self.unique_id = worker_id + ':' + assignment_id

    def log(self, msg):
        logger.info('{}: {}'.format(self.participant_id, msg))

    @cached_property
    def driver(self):
        """Returns a Selenium WebDriver instance of the type requested in the
        configuration."""
        from dallinger.config import get_config
        config = get_config()
        if not config.ready:
            config.load()
        driver_url = config.get('webdriver_url', None)
        driver_type = config.get('webdriver_type', 'phantomjs').lower()

        if driver_url:
            capabilities = {}
            if driver_type == 'firefox':
                capabilities = webdriver.DesiredCapabilities.FIREFOX
            elif driver_type == 'chrome':
                capabilities = webdriver.DesiredCapabilities.CHROME
            elif driver_type == 'phantomjs':
                capabilities = webdriver.DesiredCapabilities.PHANTOMJS
            else:
                raise ValueError(
                    'Unsupported remote webdriver_type: {}'.format(driver_type))
            driver = webdriver.Remote(
                desired_capabilities=capabilities,
                command_executor=driver_url
            )
        elif driver_type == 'phantomjs':
            driver = webdriver.PhantomJS()
        elif driver_type == 'firefox':
            driver = webdriver.Firefox()
        elif driver_type == 'chrome':
            driver = webdriver.Chrome()
        else:
            raise ValueError(
                'Unsupported webdriver_type: {}'.format(driver_type))
        driver.set_window_size(1024, 768)
        logger.info("Created {} webdriver.".format(driver_type))
        return driver

    def sign_up(self):
        """Accept HIT, give consent and start experiment.

        This uses Selenium to click through buttons on the ad,
        consent, and instruction pages.
        """
        try:
            self.driver.get(self.URL)
            logger.info("Loaded ad page.")
            begin = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, 'btn-primary')))
            begin.click()
            logger.info("Clicked begin experiment button.")
            WebDriverWait(self.driver, 10).until(
                lambda d: len(d.window_handles) == 2)
            self.driver.switch_to_window(self.driver.window_handles[-1])
            self.driver.set_window_size(1024, 768)
            logger.info("Switched to experiment popup.")
            consent = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.ID, 'consent')))
            consent.click()
            logger.info("Clicked consent button.")
            participate = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, 'btn-success')))
            participate.click()
            logger.info("Clicked start button.")
            return True
        except TimeoutException:
            logger.error("Error during experiment sign up.")
            return False

    def participate(self):
        """Participate in the experiment.

        This method must be implemented by subclasses of ``BotBase``.
        """
        logger.error("Bot class does not define participate method.")
        raise NotImplementedError

    def complete_questionnaire(self):
        """Complete the standard debriefing form.

        This does nothing unless overridden by a subclass.
        """
        pass

    def sign_off(self):
        """Submit questionnaire and finish.

        This uses Selenium to click the submit button on the questionnaire
        and return to the original window.
        """
        try:
            feedback = WebDriverWait(self.driver, 10).until(
                EC.presence_of_element_located((By.ID, 'submit-questionnaire')))
            self.complete_questionnaire()
            feedback.click()
            logger.info("Clicked submit questionnaire button.")
            self.driver.switch_to_window(self.driver.window_handles[0])
            self.driver.set_window_size(1024, 768)
            logger.info("Switched back to initial window.")
            return True
        except TimeoutException:
            logger.error("Error during experiment sign off.")
            return False

    def complete_experiment(self, status):
        """Sends worker status ('worker_complete' or 'worker_failed')
        to the experiment server.
        """
        url = self.driver.current_url
        p = urllib.parse.urlparse(url)
        complete_url = '%s://%s/%s?participant_id=%s'
        complete_url = complete_url % (p.scheme,
                                       p.netloc,
                                       status,
                                       self.participant_id)
        self.driver.get(complete_url)
        logger.info("Forced call to %s: %s" % (status, complete_url))

    def run_experiment(self):
        """Sign up, run the ``participate`` method, then sign off and close
        the driver."""
        try:
            self.sign_up()
            self.participate()
            if self.sign_off():
                self.complete_experiment('worker_complete')
            else:
                self.complete_experiment('worker_failed')
        finally:
            self.driver.quit()


class HighPerformanceBotBase(BotBase):
    """A base class for bots that do not interact using a real browser.

    Instead, this kind of bot makes requests directly to the experiment server.
    """

    @property
    def driver(self):
        raise NotImplementedError

    @property
    def host(self):
        parsed = urllib.parse.urlparse(self.URL)
        return urllib.parse.urlunparse([parsed.scheme, parsed.netloc, '', '', '', ''])

    def run_experiment(self):
        """Runs the phases of interacting with the experiment
        including signup, participation, signoff, and recording completion.
        """
        self.sign_up()
        self.participate()
        if self.sign_off():
            self.complete_experiment('worker_complete')
        else:
            self.complete_experiment('worker_failed')

    def sign_up(self):
        """Signs up a participant for the experiment.

        This is done using a POST request to the /participant/ endpoint.
        """
        self.log('Bot player signing up.')
        self.subscribe_to_quorum_channel()
        while True:
            url = (
                "{host}/participant/{self.worker_id}/"
                "{self.hit_id}/{self.assignment_id}/"
                "debug?fingerprint_hash={hash}".format(
                    host=self.host,
                    self=self,
                    hash=uuid.uuid4().hex
                )
            )
            result = requests.post(url)
            if result.status_code == 500 or result.json()['status'] == 'error':
                self.stochastic_sleep()
                continue

            self.on_signup(result.json())
            return True

    def sign_off(self):
        """Submit questionnaire and finish.

        This is done using a POST request to the /question/ endpoint.
        """
        self.log('Bot player signing off.')
        while True:
            question_responses = {"engagement": 4, "difficulty": 3}
            data = {
                'question': 'questionnaire',
                'number': 1,
                'response': json.dumps(question_responses),
            }
            url = (
                "{host}/question/{self.participant_id}".format(
                    host=self.host,
                    self=self,
                )
            )
            result = requests.post(url, data=data)
            if result.status_code == 500:
                self.stochastic_sleep()
                continue
            return True

    def complete_experiment(self, status):
        """Record worker completion status to the experiment server.

        This is done using a GET request to the /worker_complete
        or /worker_failed endpoints.
        """
        self.log('Bot player completing experiment. Status: {}'.format(status))
        while True:
            url = (
                "{host}/{status}?participant_id={participant_id}".format(
                    host=self.host,
                    participant_id=self.participant_id,
                    status=status
                )
            )
            result = requests.get(url)
            if result.status_code == 500:
                self.stochastic_sleep()
                continue
            return result

    def stochastic_sleep(self):
        delay = max(1.0 / random.expovariate(0.5), 10.0)
        gevent.sleep(delay)

    def subscribe_to_quorum_channel(self):
        """In case the experiment enforces a quorum, listen for notifications
        before creating Partipant objects.
        """
        from dallinger.experiment_server.sockets import chat_backend
        self.log("Bot subscribing to quorum channel.")
        chat_backend.subscribe(self, 'quorum')

    def on_signup(self, data):
        """Take any needed action on response from /participant call."""
        self.participant_id = data['participant']['id']
