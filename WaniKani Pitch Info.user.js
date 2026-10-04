// ==UserScript==
// @name         WaniKani Pitch Info
// @match        https://www.wanikani.com/*
// @match        https://preview.wanikani.com/*
// @namespace    https://greasyfork.org/en/scripts/31070-wanikani-pitch-info
// @version      0.84.3-alpha
// @description  Displays pitch accent diagrams on WaniKani vocab and session pages. Patched for the Userscripts extension for Safari (no @resource / GM_* / unsafeWindow).
// @author       Invertex
// @supportURL   http://invertex.xyz
// @run-at       document-idle
// @inject-into  page
// @require      https://greasyfork.org/scripts/430565-wanikani-item-info-injector/code/WaniKani%20Item%20Info%20Injector.user.js?version=1951553
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/treyharris/WaniKani-Pitch-Info/userscripts-safari/WaniKani%20Pitch%20Info.user.js
// @updateURL    https://raw.githubusercontent.com/treyharris/WaniKani-Pitch-Info/userscripts-safari/WaniKani%20Pitch%20Info.user.js
// ==/UserScript==

(function() {
  'use strict';
  /* global wkItemInfo */
  /* eslint no-multi-spaces: off */
  // Running in the page context, so the page's own window is visible directly.
  // (Declared inside the IIFE so it can't overwrite the real window.wkof global.)
  let wkof = window.wkof || null;

  // Formerly an @resource; fetched and cached instead, since Userscripts has no GM_getResourceText.
  const ACCENTS_URL = 'https://raw.githubusercontent.com/mifunetoshiro/kanjium/94473cd69598abf54cc338a0b89f190a6c02a01c/data/source_files/raw/accents.txt';
  const ACCENTS_CACHE = 'wk-pitch-info';
  let accentsPromise = null;

  const SHOW_PITCH_DESCRIPTION = true;
  const SQUASH_DIGRAPHS = false;
  const PRE_PARSE = false; // load entire "accents.txt" into an object for faster lookup (true: lookup takes ~0.06ms; false: lookup takes ~0.5ms)
  const DOT_RADIUS = 0.2;
  const STROKE_WIDTH = 0.1;

  const WEB_URL = 'http://www.gavo.t.u-tokyo.ac.jp/ojad/search/index/curve:fujisaki/word:%s';
  let digraphs = 'ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶ';

  let pitchLookup = null;

  // Get the color and the pitch pattern name
  let patternObj = {
    heiban: {
      name: '平板',
      nameEng: 'heiban',
      cssClass: 'heiban',
      color: '#d20ca3',
    },
    odaka: {
      name: '尾高',
      nameEng: 'odaka',
      cssClass: 'odaka',
      color: '#0cd24d',
    },
    nakadaka: {
      name: '中高',
      nameEng: 'nakadaka',
      cssClass: 'nakadaka',
      color: '#27a2ff',
    },
    atamadaka: {
      name: '頭高',
      nameEng: 'atamadaka',
      cssClass: 'atamadaka',
      color: '#EA9316',
    },
    unknown: {
      name: '不詳',
      nameEng: 'No pitch value found, click the number for more info.',
      cssClass: 'unknown',
      color: '#CCCCCC',
    },
  };

  const JAPANESE_TO_WORD_TYPE = {
    名: 'Noun',
    代: 'Pronoun',
    副: 'Adverb',
    形動: 'な Adjective',
    感: 'Interjection'
  };

  // Check for WaniKani Open Framework
  if (!wkof) {
    console.warn('WaniKani Pitch Info has extra features enabled by the WK Open Framework.\n Visit: https://community.wanikani.com/t/instructions-installing-wanikani-open-framework/28549 to install.');
    startup();
  } else {
    wkof.include('Menu,Settings');
    wkof.ready('Menu,Settings')
      .then(install_menu)
      .then(startup)
      .then(setupInjectPitchIntoReviewQuestionArea);

    function install_menu() {
      try {
        wkof.Menu.insert_script_link({
          name: 'wanikani_pitch_info',
          submenu: 'Settings',
          title: 'WaniKani Pitch Info',
          on_click: open_settings
        });
      } catch (e) {
        console.error(e);
      }

      wkof.Settings.load('wanikani_pitch_info');
    }

    function open_settings() {
      var config = {
        script_id: 'wanikani_pitch_info',
        title: 'WaniKani Pitch Info Settings',
        autosave: true,
        content: {
          display_pitch_beside_question: {
            type: 'checkbox',
            label: 'Display pitch beside question',
            default: false,
            hover_tip: 'After successfully completing a reading review, display pitch beside the question.',
          },
        }
      }
      var dialog = new wkof.Settings(config);
      dialog.open();
    }

    function setupInjectPitchIntoReviewQuestionArea() {
      // Injects pitch accent and reading into question area.
      // Pitch is only displayed when the user enters a correct reading
      window.wkPitchInfoScriptObjectsToRemove = [];

      // didAnswerQuestion will be triggered whenever the user answers a question
      window.addEventListener('didAnswerQuestion', () => {
        console.debug('didAnswerQuestion');
        // Remove any boxes from an earlier answer to this same question. Double-Check fires
        // didAnswerQuestion again on resubmit and on Mark Right/Wrong, so boxes would otherwise pile up.
        clearQuestionPitch();

        // Only display pitch next to the question if the user enables it in the settings.
        if (wkof.settings.wanikani_pitch_info?.display_pitch_beside_question) {
          // Make sure that this is a vocab reading question on a supported quiz page
          if (!(['review', 'extraStudy', 'lessonQuiz'].includes(wkItemInfo.currentState.on) && wkItemInfo.currentState.type == 'vocabulary' && wkItemInfo.currentState.under.includes('reading'))) {
            console.debug('Not a vocab reading question on a supported quiz page. Ignoring.');
            return;
          }

          // Figure out whether the answer is correct. Don't display the pitch if the answer is wrong.
          const userAnswer = document.querySelector('#user-response')?.value?.trim();
          if (!wkItemInfo.currentState.reading.includes(userAnswer)) {
            console.debug('User answer is wrong. Not displaying pitch.');
            return;
          }

          // Locate the html element where we want to insert our pitch after
          let divQuestion = document.querySelector('div.character-header__characters');
          if (!divQuestion) {
            console.error('Unable to locate divQuestion.');
            return;
          }


          // Build one box per distinct reading; a reading with several pitch patterns stays in one box.
          // Spellings that differ only in hiragana vs. katakana count as the same reading.
          const groups = new Map();
          for (const reading of wkItemInfo.currentState.reading) {
            if (!reading) continue;
            const key = toHiragana(reading);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(reading);
          }
          const boxes = [];
          for (const [key, variants] of groups) {
            // Prefer the spelling the user typed; fall back to other spellings if it has no pitch data
            variants.sort((a, b) => (b === userAnswer) - (a === userAnswer));
            for (const reading of variants) {
              console.debug(`reading: ${reading}`);
              var divOuter = document.createElement('div');
              divOuter.setAttribute('class', 'additional-content__content additional-content__content--open subject-section subject-section--reading subject-section--collapsible subject-section__subsection subject-readings-with-audio subject-readings-with-audio__item');

              var divReading = document.createElement('div');
              divReading.setAttribute('class', 'reading-with-audio__reading question-pitch-display');
              divReading.setAttribute('lang', 'ja');
              divReading.innerHTML = `${reading}`;
              divOuter.appendChild(divReading);

              injectPitchInfoToSingleElement(wkItemInfo.currentState, divReading);
              // No pitch data for this reading (e.g. a 〜 prefix/suffix entry): don't show an empty white box
              if (!divOuter.querySelector('.pitch-diagram')) continue;
              boxes.push({ key, divOuter });
              break;
            }
          }

          // Show the box for the reading the user answered; keep the others hidden behind a link,
          // so they don't give away a reading the user may want to try recalling.
          const answered = boxes.find(b => b.key === toHiragana(userAnswer));
          const others = boxes.filter(b => b !== answered);
          others.forEach(b => b.divOuter.hidden = true);

          let anchor = divQuestion;
          const place = el => {
            anchor.insertAdjacentElement('afterend', el);
            window.wkPitchInfoScriptObjectsToRemove.push(el);
            anchor = el;
          };

          let linkHome = answered?.divOuter;
          if (!linkHome && others.length > 0) {
            // The answered reading has no pitch data, but others do: show just the link
            linkHome = document.createElement('div');
            linkHome.classList.add('pitch-more-readings-solo');
            place(linkHome);
          }
          if (answered) place(answered.divOuter);
          others.forEach(b => place(b.divOuter));

          if (others.length > 0) {
            const n = others.length;
            const link = document.createElement('a');
            link.href = '#';
            link.setAttribute('role', 'button');
            link.classList.add('pitch-more-readings');
            link.textContent = `+${n} more reading${n === 1 ? '' : 's'}…`;
            link.addEventListener('click', e => {
              e.preventDefault();
              e.stopPropagation();
              others.forEach(b => b.divOuter.hidden = false);
              link.remove();
              if (linkHome.classList.contains('pitch-more-readings-solo')) linkHome.remove();
            });
            linkHome.appendChild(link);
          }
        }
      })

      // Cleans up the objects that we inject into the question area
      function clearQuestionPitch() {
        window.wkPitchInfoScriptObjectsToRemove.forEach(pObject => pObject.remove());
        window.wkPitchInfoScriptObjectsToRemove = [];
      }
      // willShowNextQuestion: a new question is about to load.
      // didUnanswerQuestion: fired by the Double-Check userscript when an answer is reset for retyping.
      window.addEventListener('willShowNextQuestion', clearQuestionPitch);
      window.addEventListener('didUnanswerQuestion', clearQuestionPitch);
    }
  }

  function startup() {
    addCss();
    // Data now arrives asynchronously, so load it before registering the injectors.
    return loadPitchInfo().then(() => {
      wkItemInfo.forType('vocabulary').under('reading').notifyWhenVisible(injectPitchInfo);
      wkItemInfo.forType('kanaVocabulary').under('meaning').notifyWhenVisible(injectPitchInfo);
    }).catch(e => console.error('WaniKani Pitch Info: could not load pitch data.', e));
  }

  function injectPitchInfoToSingleElement(injectorState, pReading) {
    let reading = pReading.textContent;
    let pitchInfo = getPitchInfo(injectorState.characters, injectorState.type === 'kanaVocabulary' ? '' : reading);
    if (!pitchInfo) return;
    let dInfo = null;
    let wordTypes = [...new Set([...pitchInfo.matchAll(/[\(;]([^\);]*)/g)].flatMap(r => r[1]))];
    if (wordTypes.length > 0) {
      let wordTypeToPitch = wordTypes.map(w => [w, [...pitchInfo.matchAll(new RegExp(w + '[^\\)]*\\)([\\d,]+)', 'g'))].flatMap(r => r[1]).join('').split(',').filter(p => p).map(p => parseInt(p))]);
      dInfo = appendPitchPatternInfo(pReading, pitchByWordTypeToInfoElements(wordTypeToPitch, injectorState.characters, reading));
      pitchInfo = [...new Set([...pitchInfo.matchAll(/\d/g)].map(r => r[0]))].map(p => parseInt(p));
    } else {
      pitchInfo = pitchInfo.split(',').map(p => parseInt(p));
      dInfo = appendPitchPatternInfo(pReading, pitchToInfoElements(pitchInfo, injectorState.characters, reading));
    }
    let diagrams = pitchInfo.map(p => drawPitchDiagram(p, reading));
    pReading.before(...diagrams);
    if ("injector" in injectorState) {
      [...diagrams, dInfo].forEach(d => {
        if (d) injectorState.injector.registerAppendedElement(d);
      });
    }
    makeMonospaced(pReading.childNodes[0]);
  }

  function injectPitchInfo(injectorState) {
    document.querySelectorAll('.pronunciation-variant:not(.question-pitch-display), .subject-readings-with-audio__reading:not(.question-pitch-display), .reading-with-audio__reading:not(.question-pitch-display)').forEach(pReading => {
      injectPitchInfoToSingleElement(injectorState, pReading);
    });
  }

  function pitchByWordTypeToInfoElements(wordTypeToPitch, vocab, reading) {
    let result = wordTypeToPitch.flatMap(([wordType, pitch]) => [`${JAPANESE_TO_WORD_TYPE[wordType]}: `, ...pitchToInfoElements(pitch, vocab, reading), ', ']);
    result.pop();
    return result;
  }

  function pitchToInfoElements(pitch, vocab, reading) {
    return pitch.flatMap((p, i) => [i === 0 ? '' : ' or ', generatePatternText(p, vocab, reading)]);
  }

  function appendPitchPatternInfo(readingElement, infoElements) {
    if (!SHOW_PITCH_DESCRIPTION) return null;
    let dInfo = document.createElement('div');
    let hInfo = document.createElement('h3');
    let pInfo = document.createElement('p');
    hInfo.textContent = 'Pitch Pattern';
    dInfo.classList.add('pitch-pattern');
    pInfo.append(...infoElements);
    dInfo.append(hInfo, pInfo);
    readingElement.after(dInfo);
    return dInfo;
  }

  function fetchAccents() {
    // The URL is pinned to a commit, so a cached copy never goes stale.
    if (!accentsPromise) {
      accentsPromise = (async () => {
        let cache = null;
        try {
          if (window.caches) {
            cache = await caches.open(ACCENTS_CACHE);
            const cached = await cache.match(ACCENTS_URL);
            if (cached) return await cached.text();
          }
        } catch (e) {
          console.debug('WaniKani Pitch Info: cache unavailable', e);
          cache = null;
        }
        const response = await fetch(ACCENTS_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching accents.txt`);
        if (cache) {
          try { await cache.put(ACCENTS_URL, response.clone()); }
          catch (e) { console.debug('WaniKani Pitch Info: could not cache accents.txt', e); }
        }
        return await response.text();
      })();
      accentsPromise.catch(() => { accentsPromise = null; }); // allow a retry on the next page load
    }
    return accentsPromise;
  }

  async function loadPitchInfo() {
    if (pitchLookup) return;
    let accents = await fetchAccents();
    if (pitchLookup) return;
    if (!PRE_PARSE || wkItemInfo.currentState.on === 'itemPage') {
      pitchLookup = (vocab, reading) => pitchLookupTextfile(vocab, reading, accents);
      return;
    }
    let lookupObject = {};
    let matches = accents.matchAll(/^([^\t]+\t[^\t]+)\t(.+)$/gm);
    for (const match of matches) lookupObject[match[1]] = match[2]; // fastest
    //  let matches = [...accents.matchAll(/^([^\t]+\t[^\t]+)\t(.+)$/gm)];
    //  lookupObject = matches.reduce((o, m) => { o[m[1]] = m[2]; return o; }, {}); // faster
    //  lookupObject = Object.fromEntries(matches.map(m => [m[1], m[2]]));          // slower
    pitchLookup = (vocab, reading) => pitchLookupObject(vocab, reading, lookupObject);
  }

  function pitchLookupTextfile(vocab, reading, accents) {
    let key = `\n${vocab}\t${reading}\t`;
    let start = accents.indexOf(key);
    if (start < 0) return null;
    start += key.length;
    let end = accents.indexOf('\n', start);
    return accents.substring(start, end);
  }

  function pitchLookupObject(vocab, reading, lookupObject) {
    return lookupObject[vocab + '\t' + reading];
  }

  function getPitchInfo(vocab, reading) {
    if (!pitchLookup) return null; // data not loaded (yet)
    let result = pitchLookup(vocab, reading);
    if (!result) result = pitchLookup(vocab.replace(/する$/, ''), reading.replace(/する$/, ''));
    // Mixed kanji/katakana words (消しゴム): WaniKani's primary reading is all hiragana (けしごむ),
    // but the accent data keeps the katakana (けしゴム)
    if (!result) {
      const mixed = carryKatakana(vocab, reading);
      if (mixed && mixed !== reading) result = pitchLookup(vocab, mixed);
    }
    if (!result) result = pitchLookup(toHiragana(vocab), toHiragana(reading));
    if (!result) result = pitchLookup(toKatakana(vocab), toKatakana(reading));
    return result;
  }

  // Rewrite each katakana run of the word into the reading, in order: (消しゴム, けしごむ) → けしゴム
  function carryKatakana(vocab, reading) {
    let out = reading, pos = 0;
    for (const run of vocab.match(/[\u30A1-\u30FA\u30FC]+/g) || []) {
      const h = toHiragana(run);
      const i = out.indexOf(h, pos);
      if (i < 0) return null;
      out = out.slice(0, i) + run + out.slice(i + h.length);
      pos = i + run.length;
    }
    return out;
  }

  function toHiragana(kana) {
    let arr = [...kana];
    return arr.map(c => c.charCodeAt(0)).map(c => (12449 <= c && c <= 12534) ? c - 96 : c).map(c => String.fromCharCode(c)).join('');
  }

  function toKatakana(kana) {
    let arr = [...kana];
    return arr.map(c => c.charCodeAt(0)).map(c => (12353 <= c && c <= 12438) ? c + 96 : c).map(c => String.fromCharCode(c)).join('');
  }

  function getPitchType(pitchNum, moraCount) {
    if (pitchNum == 0) return patternObj.heiban;
    if (pitchNum == 1) return patternObj.atamadaka;
    if (pitchNum == moraCount) return patternObj.odaka;
    if (pitchNum < moraCount) return patternObj.nakadaka;
    return patternObj.unknown;
  }

  function getMoraCount(reading) {
    return [...reading].filter(c => !digraphs.includes(c)).length;
  }

  function drawPitchDiagram(pitchNum, reading) {
    let moraCount = getMoraCount(reading);
    let width = SQUASH_DIGRAPHS ? moraCount : reading.length;
    let patternType = getPitchType(pitchNum, moraCount);

    let namespace = 'http://www.w3.org/2000/svg';
    let svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', `-0.5 -0.25 ${width + 1} 1.5`);

    let xCoords = [];
    for (let i = 0; i <= reading.length; i++) { // using "<=" to get additional iteration for particle node
      if (!SQUASH_DIGRAPHS && digraphs.includes(reading[i])) {
        xCoords[xCoords.length - 1] += 0.5;
      } else {
        xCoords.push(i);
      }
    }
    let yCoords = new Array(moraCount + 1).fill(null);
    yCoords = yCoords.map((_, i) => {
      if (pitchNum == 0) return i === 0 ? 1 : 0;
      if (i + 1 == pitchNum) return 0;
      if (i === 0) return 1;
      return i < pitchNum ? 0 : 1;
    });
    let points = yCoords.map((y, i) => ({
      x: xCoords[i],
      y
    }));

    let polyline = document.createElementNS(namespace, 'polyline');
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', patternType.color);
    polyline.setAttribute('stroke-width', STROKE_WIDTH);
    polyline.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
    svg.appendChild(polyline);

    points.forEach((p, i) => {
      let isParticle = i === points.length - 1;
      let circle = document.createElementNS(namespace, 'circle');
      circle.setAttribute('fill', isParticle ? '#eeeeee' : patternType.color);
      circle.setAttribute('stroke', isParticle ? 'black' : patternType.color);
      circle.setAttribute('stroke-width', isParticle ? STROKE_WIDTH / 2 : 0);
      circle.setAttribute('cx', p.x);
      circle.setAttribute('cy', p.y);
      circle.setAttribute('r', DOT_RADIUS);
      svg.appendChild(circle);
    });
    let p = document.createElement('p');
    p.classList.add('pitch-diagram');
    p.lang = 'ja'; // to match the WK CSS selector containing the reading font size
    p.appendChild(svg);
    return p;
  }

  function generatePatternText(pitchNum, vocab, reading) {
    let moraCount = getMoraCount(reading);
    let patternType = getPitchType(pitchNum, moraCount);
    let sName = document.createElement('span');
    let aLink = document.createElement('a');
    aLink.href = WEB_URL.replace('%s', vocab);
    aLink.target = '_blank';
    aLink.title = `Pitch Pattern: ${patternType.nameEng} (${patternType.name})`;
    aLink.textContent = `[${pitchNum}]`;
    sName.textContent = patternType.name + ' ';
    sName.classList.add(patternType.cssClass);
    sName.appendChild(aLink);
    return sName;
  }

  function makeMonospaced(textNode) {
    let characters = [...textNode.textContent];
    if (SQUASH_DIGRAPHS) {
      characters.forEach((c, i, a) => {
        if (digraphs.includes(c)) a[i - 1] += c;
      });
      characters = characters.filter(c => !digraphs.includes(c));
    }
    let spans = characters.map(c => {
      let span = document.createElement('span');
      span.textContent = c;
      span.classList.toggle('digraph', c.length > 1);
      return span;
    });
    textNode.replaceWith(...spans);
  }

  function addCss() {
    let style = document.createElement('style');
    style.textContent = `
      .pronunciation-group svg           , .subject-readings-with-audio__item svg             { height: 1.5em; width: auto; display: block; }
      .pronunciation-variant             , .subject-readings-with-audio__reading              { line-height: 2.2em; margin: 0; }
      .pronunciation-variant span        , .subject-readings-with-audio__reading span         { width: 1em; display: inline-block; text-align: center; white-space: nowrap; }
      .pronunciation-variant span.digraph, .subject-readings-with-audio__reading span.digraph { font-feature-settings: 'hwid' on; }
      .pitch-pattern                                                                          { display: flex; margin-bottom: 0; color: #999; text-transform: uppercase; }
      .pitch-pattern h3, #item-info .pitch-pattern h3                                         { margin: 0 1em 0 0; padding: 0; font-size: 11px; font-weight: bold; letter-spacing: 0; border-bottom: none; line-height: 1.6em; }
      .pitch-pattern p                                                                        { font-family: "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 11px; flex: 1 0 auto; margin: 0; }
      .pitch-diagram.pitch-diagram.pitch-diagram.pitch-diagram                                { margin: 0; display: block; font-size: 18px; }
      .pitch-pattern + .subject-readings-with-audio__audio-items                              { margin-top: 0.6em; }
      .character-header .question-pitch-display > span                                        { color: rgb(255 255 255); }
      .character-header .additional-content__content:has(> .pitch-diagram) { background-color: rgba(0.2, 0.2, 0.2, 0.2); border-style: none; padding: 6px 8px; box-shadow: rgb(227, 227, 227) 0px 2px 4px !important; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); }
      .character-header .additional-content__content:has(> .pitch-diagram) .pitch-pattern     { color: rgba(255, 255, 255, 0.8); }
      .character-header .additional-content__content:has(> .pitch-diagram) .pitch-pattern h3  { font-size: 12px; }
      .character-header .additional-content__content:has(> .pitch-diagram) .pitch-pattern p   { color: #fff; font-size: 15px; font-weight: 600; }
      .character-header .additional-content__content:has(> .pitch-diagram) .pitch-pattern p a { color: #fff; text-decoration: underline; }
      .character-header .pitch-more-readings { display: block; margin-top: 4px; color: #fff; font-size: 13px; font-weight: 600; text-decoration: underline; cursor: pointer; }
      .character-header .pitch-more-readings-solo { align-self: center; padding: 6px 8px; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); }
      ${Object.values(patternObj).map(({color, cssClass}) => `.character-header .additional-content__content:has(> .pitch-diagram) .pitch-pattern p .${cssClass} { color: ${color}; }`).join('\n      ')}`;
    document.head.appendChild(style);
  }
})();
