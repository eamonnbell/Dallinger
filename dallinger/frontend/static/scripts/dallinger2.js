/*globals Spinner, Fingerprint2, ReconnectingWebSocket, reqwest, store */

if (window.Dallinger !== undefined) {
  alert(
    'This page has loaded both dallinger.js and dallinger2.js at the same time, ' +
    'which is not supported. It is recommended to use dallinger2.js ' +
    'for experiments being actively developed, and dallinger.js only ' +
    'for backwards compatibility of existing experiments.'
  );
}

var dallinger = (function () {
  var dlgr = {};

  dlgr.skip_experiment = false;

  dlgr.getUrlParameter = function getUrlParameter(sParam) {
    var sPageURL = decodeURIComponent(window.location.search.substring(1)),
      sURLVariables = sPageURL.split('&'),
      sParameterName,
      i;

    for (i = 0; i < sURLVariables.length; i++) {
      sParameterName = sURLVariables[i].split('=');
      if (sParameterName[0] === sParam) {
        return sParameterName[1] === undefined ? true : sParameterName[1];
      }
    }
  };

  dlgr.identity = {
    recruiter: dlgr.getUrlParameter('recruiter'),
    hitId: dlgr.getUrlParameter('hit_id'),
    workerId: dlgr.getUrlParameter('worker_id'),
    assignmentId: dlgr.getUrlParameter('assignment_id'),
    mode: dlgr.getUrlParameter('mode'),
    participantId: dlgr.getUrlParameter('participant_id')
  };

  dlgr.BusyForm = (function () {
    /**
    Loads a spinner as a visual cue that something is happening
    and disables any jQuery objects passed to freeze().
    **/

    var defaults = {
      spinnerSettings: {scale: 1.5}, // See http://spin.js.org/ for all settings
      spinnerID: 'spinner'  // ID for HTML element where spinner will be inserted
    };

    var BusyForm = function (options) {
      if (!(this instanceof BusyForm)) {
        return new BusyForm(options);
      }
      var settings = $.extend(true, {}, defaults, options);
      this.spinner = new Spinner(settings.spinnerSettings);
      this.target = document.getElementById(settings.spinnerID);
      if (this.target === null) {
        throw new Error(
          'Target HTML element for spinner with ID "' + settings.spinnerID +
          '" does not exist.');
      }
      this.$elements = [];
    };

    BusyForm.prototype.freeze = function ($elements) {
      this.$elements = $elements;
      this.$elements.forEach(function ($element) {
        $element.attr("disabled", true);
      });
      this.spinner.spin(this.target);
    };

    BusyForm.prototype.unfreeze = function () {
      this.$elements.forEach(function ($element) {
        $element.attr("disabled", false);
      });
      this.spinner.stop();
      this.$elements = [];
    };

    return BusyForm;
  }());

  dlgr.AjaxRejection = (function () {
    /**
    Capture information related to a rejected dallinger.ajax() call.
    **/

    var _responseHTML = function (response) {
      var parsed;
      try {
        parsed = JSON.parse(response);
      } catch (error) {
        console.log('Error response not parseable.');
        parsed = {};
      }
      if (parsed.hasOwnProperty('html')) {
        return parsed.html;
      }
      return ''
    };

    var AjaxRejection = function (options) {
      if (!(this instanceof AjaxRejection)) {
        return new AjaxRejection(options);
      }

      this.route = options.route;
      this.method = options.method;
      this.data = options.data || {};
      this.error = options.error;
      this.status = options.error.status;
      this.html = _responseHTML(this.error.response);
      this.requestJSON = JSON.stringify({
        'route': this.route,
        'data': JSON.stringify(this.data),
        'method': this.method
      })
    };

    return AjaxRejection;
  }());

  // stop people leaving the page, but only if desired by experiment
  dlgr.allowExitOnce = false;
  dlgr.preventExit = false;
  window.addEventListener('beforeunload', function(e) {
    if (dlgr.preventExit && !dlgr.allowExitOnce) {
      var returnValue = "Warning: the study is not yet finished. " +
        "Closing the window, refreshing the page or navigating elsewhere " +
        "might prevent you from finishing the experiment.";
      e.returnValue = returnValue;
      return returnValue;
    } else {
      dlgr.allowExitOnce = false;
      return undefined;
    }
  });
  // allow actions to leave the page
  dlgr.allowExit = function() {
    dlgr.allowExitOnce = true;
  };

  // advance the participant to a given html page
  dlgr.goToPage = function(page) {
    window.location = "/" + page + "?participant_id=" + dlgr.identity.participantId;
  };

  var add_hidden_input = function ($form, name, val) {
    if (val) {
      $form.append($('<input>').attr('type', 'hidden').attr('name', name).val(val));
    }
  };

  var get_hit_params = function() {
    // check if the local store is available, and if so, use it.
    var data = {};
    if (typeof store !== "undefined") {
      data.recruiter = store.get("recruiter");
      data.worker_id = store.get("worker_id");
      data.hit_id = store.get("hit_id");
      data.assignment_id = store.get("assignment_id");
      data.mode = store.get("mode");
      data.fingerprint_hash = store.get("fingerprint_hash");
    } else {
      data.recruiter = dlgr.identity.recruiter;
      data.worker_id = dlgr.identity.worker_id;
      data.hit_id = dlgr.identity.hit_id;
      data.assignment_id = dlgr.identity.assignment_id;
      data.mode = dlgr.identity.mode;
    }
    return data;
  };

  // AJAX helpers

  var ajax = function (method, route, data) {
    var deferred = $.Deferred();
    var options = {
      url: route,
      method: method,
      type: 'json',
      success: function (resp) { deferred.resolve(resp); },
      error: function (err) {
        console.log(err);
        var rejection = dlgr.AjaxRejection(
          {'route': route, 'method': method, 'data': data, 'error': err}
        );
        deferred.reject(rejection);
      }
    };
    if (data !== undefined) {
      options.data = data;
    }
    reqwest(options);
    return deferred;
  };

  dlgr.get = function (route, data) {
    return ajax('get', route, data);
  };

  dlgr.post = function (route, data) {
    return ajax('post', route, data);
  };

  dlgr.error = function (rejection) {
    // Render an error form for a rejected deferred returned by an ajax() call.
    var $form, hit_params;
    console.log("Calling dallinger.error()");

    if (rejection.html) {
      $('html').html(rejection.html);
      $form = $('form#error-response');
    } else {
      $form = $('<form>').attr('action', '/error-page').attr('method', 'POST');
      $('body').append($form);
    }
    if (rejection.data.participant_id) {
      add_hidden_input($form, 'participant_id', rejection.data.participant_id);
    }
    add_hidden_input($form, 'request_data', rejection.requestJSON);
    hit_params = get_hit_params();
    for (var prop in hit_params) {
      if (hit_params.hasOwnProperty(prop)) add_hidden_input($form, prop, hit_params[prop]);
    }
    if (!rejection.html) {
      $form.submit();
    }
  }

  // report assignment complete
  dlgr.submitAssignment = function() {
    var deferred = $.Deferred();
    dlgr.get('/participant/' + dlgr.identity.participantId).done(function (resp) {
      dlgr.identity.mode = resp.participant.mode;
      dlgr.identity.hitId = resp.participant.hit_id;
      dlgr.identity.assignmentId = resp.participant.assignment_id;
      dlgr.identity.workerId = resp.participant.worker_id;
      dlgr.get('/worker_complete', {
        'participant_id': dlgr.identity.participantId
      }).done(function () {
        deferred.resolve();
        dallinger.allowExit();
        window.location = "/complete";
      }).fail(function (err) {
        deferred.reject(err);
      });
    }).fail(function (err) {
      deferred.reject(err);
    });
    return deferred;
  };

  // make a new participant
  dlgr.createParticipant = function() {
    var deferred = $.Deferred(),
      fingerprint_hash,
      url,
      hit_params;
    if (dlgr.missingFingerprint()) {
      window.alert(
        'An ad blocker is preventing this experiment from ' +
        'loading. Please disable it and reload the page.'
      )
      return;
    }
    new Fingerprint2().get(function(result){
      fingerprint_hash = result;
      store.set("fingerprint_hash", fingerprint_hash);
    });

    hit_params = get_hit_params();
    url = "/participant/" + hit_params.worker_id + "/" + hit_params.hit_id +
      "/" + hit_params.assignment_id + "/" + hit_params.mode + "?fingerprint_hash=" +
      (hit_params.fingerprint_hash || fingerprint_hash) + '&recruiter=' + hit_params.recruiter;

    if (dlgr.identity.participantId !== undefined && dlgr.identity.participantId !== 'undefined') {
      deferred.resolve();
    } else {
      $(function () {
        $('.btn-success').prop('disabled', true);
        dlgr.post(url).done(function (resp) {
          console.log(resp);
          $('.btn-success').prop('disabled', false);
          dlgr.identity.participantId = resp.participant.id;
          if (resp.quorum && resp.quorum.n !== resp.quorum.q) {
            if (resp.quorum.overrecruited) {
              dlgr.skip_experiment = true;
              // reached quorum; resolve immediately
              deferred.resolve();
            } else {
              // wait for quorum, then resolve
              dlgr.updateProgressBar(resp.quorum.n, resp.quorum.q);
              dlgr.waitForQuorum().done(function () {
                deferred.resolve();
              });
            }
          } else {
            // no quorum; resolve immediately
            deferred.resolve();
          }
        });
      });
    }
    return deferred;
  };

  dlgr.createAgent = function () {
    return dlgr.post('/node/' + dallinger.identity.participantId);
  };

  dlgr.createInfo = function (nodeId, data) {
    return dlgr.post('/info/' + nodeId, data);
  };

  dlgr.getExperimentProperty = function (prop) {
    return dlgr.get('/experiment/' + prop);
  };

  dlgr.getInfo = function (nodeId, infoId) {
    return dlgr.get('/info/' + nodeId + '/' + infoId);
  };

  dlgr.getInfos = function (nodeId) {
    return dlgr.get('/node/' + nodeId + '/infos');
  };

  dlgr.getReceivedInfos = function (nodeId) {
    return dlgr.get('/node/' + nodeId + '/received_infos');
  };

  dlgr.getTransmissions = function (nodeId, data) {
    return dlgr.get('/node/' + nodeId + '/transmissions', data);
  };

  dlgr.submitQuestionnaire = function (name) {
    var formSerialized = $("form").serializeArray(),
      spinner = dlgr.BusyForm(),
      formDict = {},
      xhr;

    formSerialized.forEach(function (field) {
      formDict[field.name] = field.value;
    });

    xhr = dlgr.post('/question/' + dlgr.identity.participantId, {
      question: name || "questionnaire",
      number: 1,
      response: JSON.stringify(formDict)
    });
    spinner.freeze([$('form :input')]);
    xhr.done(dlgr.submitAssignment);
    xhr.always(function () { spinner.unfreeze(); });
  };

  dlgr.waitForQuorum = function () {
    var ws_scheme = (window.location.protocol === "https:") ? 'wss://' : 'ws://';
    var socket = new ReconnectingWebSocket(ws_scheme + location.host + "/chat?channel=quorum");
    var deferred = $.Deferred();
    socket.onmessage = function (msg) {
      if (msg.data.indexOf('quorum:') !== 0) { return; }
      var data = JSON.parse(msg.data.substring(7));
      var n = data.n;
      var quorum = data.q;
      dlgr.updateProgressBar(n, quorum);
      if (n === quorum) {
        deferred.resolve();
      }
    };
    return deferred;
  };

  dlgr.updateProgressBar = function (value, total) {
    var percent = Math.round((value / total) * 100.0) + '%';
    $("#waiting-progress-bar").css("width", percent);
    $("#progress-percentage").text(percent);
  };

  dlgr.missingFingerprint = function () {
    if (window.Fingerprint2 === undefined) {
      return true;
    }
    return false;
  }

  dlgr.hasAdBlocker = function (callback) {
    var test = document.createElement('div');
    test.innerHTML = '&nbsp;';
    test.className = 'adsbox';
    document.body.appendChild(test);
    window.setTimeout(function() {
      if (test.offsetHeight === 0) {
        return callback();
      }
      test.remove();
    }, 100);
  }

  return dlgr;
}());

