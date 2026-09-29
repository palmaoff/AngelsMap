/* =====================================================================
   Общая логика generic-форм настроек (фильтров) — используется и панелью
   слоёв (map.js: openLayerSettings/applyLayerSettings), и вкладкой «Отчёты»
   (reports.js), поверх одной и той же разметки #settingsOverlay/#settingsBody
   (см. buildChrome() в map.js). Сервер отдаёт готовый HTML-фрагмент формы
   (.settings-form/.settings-form__row/...), клиент не знает о конкретных
   полях конкретного слоя/отчёта — единственный контракт: каждый ввод имеет
   name = имя ключа фильтра и HTML-тип, однозначно говорящий, как читать
   значение (checkbox/number/select[multiple]/остальное — строка).
   ===================================================================== */

const SettingsForm = (function () {

  // Некоторые поля формы имеют смысл, только если другое поле формы принимает
  // определённое значение (например, поле даты среза для «Автобусов» видно,
  // только пока выключен чекбокс «за период» — см. АнгелКартографияВнешнееAPI.
  // РядДатаВремя/АтрибутПоказать). Сервер размечает такую строку атрибутом
  // data-show-if="имяПоля=ожидаемоеЗначение" — клиент здесь ничего не знает о
  // смысле конкретных полей, просто сравнивает текущее значение поля со
  // строкой после "=" (для чекбоксов — "true"/"false") и показывает/прячет
  // строку целиком. Вложенность условий (строка внутри уже скрытой строки)
  // разруливается сама собой через display:none у родителя.
  function applySettingsDependencies(container) {
    container.querySelectorAll('[data-show-if]').forEach(row => {
      const [name, expected] = row.dataset.showIf.split('=');
      const field = container.querySelector(`[name="${name}"]`);
      if (!field) { row.style.display = ''; return; }
      const value = field.type === 'checkbox' ? String(field.checked) : field.value;
      row.style.display = value === expected ? '' : 'none';
    });
  }

  function wireSettingsDependencies(container) {
    const handler = () => applySettingsDependencies(container);
    container.addEventListener('change', handler);
    handler();
  }

  // Взаимоисключающая пара чекбоксов (например, "Сравнивать кварталы"/"Сравнивать года" в
  // форме настроек отчёта «Аварийность (сводный)» — см. ААКартографияВнешнееAPI.
  // АтрибутИсключения/РядЧекбокс) — сервер помечает такой чекбокс атрибутом
  // data-exclusive-with="имяДругогоПоля" (или список имён через запятую:
  // "поле1,поле2"); при его включении снимаем отметку с чекбоксов, на которые он
  // указывает (если они есть в той же форме), и рассылаем change на снятые поля — на
  // случай, если от них зависят другие data-show-if строки. Тот же принцип
  // "сервер размечает, клиент не знает о смысле конкретных полей", что и
  // applySettingsDependencies выше.
  function wireExclusiveCheckboxes(container) {
    container.querySelectorAll('[data-exclusive-with]').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        if (!checkbox.checked) return;
        checkbox.dataset.exclusiveWith.split(',').map(s => s.trim()).filter(Boolean).forEach(name => {
          const other = container.querySelector(`[name="${name}"]`);
          if (other && other !== checkbox && other.checked) {
            other.checked = false;
            other.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      });
    });
  }

  // Сервер отдаёт список выбора как обычный <select multiple> (см. АнгелКартографияВнешнееAPI.
  // РядВыбор) — читаемо для collectSettingsValues, но неудобно для пользователя (выбор через
  // Ctrl+клик). Прячем сам select (остаётся источником истины для collectSettingsValues/
  // applySettingsDependencies) и рисуем рядом список строк с чекбоксами слева; клик по чекбоксу
  // выставляет option.selected, дальше всё работает как раньше.
  // Порог, с которого над чек-листом появляется строка поиска — ниже него пролистать
  // глазами быстрее, чем печатать (см. .settings-form__checklist-search в css/styles.css).
  const CHECKLIST_SEARCH_THRESHOLD = 8;

  function enhanceMultiSelects(container) {
    container.querySelectorAll('select[multiple]').forEach(select => {
      const list = document.createElement('div');
      list.className = 'settings-form__checklist';

      const rows = [];
      Array.from(select.options).forEach(option => {
        const row = document.createElement('label');
        row.className = 'settings-form__check-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = option.selected;
        checkbox.addEventListener('change', () => {
          option.selected = checkbox.checked;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });

        const label = document.createElement('span');
        label.textContent = option.textContent;

        row.appendChild(checkbox);
        row.appendChild(label);
        list.appendChild(row);
        rows.push({ row, text: option.textContent.toLowerCase() });
      });

      // Обратная ссылка вместо поиска по соседям: ниже к списку может
      // добавиться строка поиска ПЕРЕД ним, и тогда select.nextElementSibling —
      // уже не чек-лист (на этом молча ломалась очистка формы у длинных
      // списков вроде ГРЗ). Читается в clearSettingsForm.
      select._checklist = list;
      select.insertAdjacentElement('afterend', list);

      if (rows.length > CHECKLIST_SEARCH_THRESHOLD) {
        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'settings-form__checklist-search';
        search.placeholder = 'Поиск…';
        search.autocomplete = 'off';
        search.addEventListener('input', () => {
          const q = search.value.trim().toLowerCase();
          rows.forEach(({ row, text }) => {
            row.classList.toggle('is-hidden', q !== '' && !text.includes(q));
          });
        });
        list._search = search;
        list._rows = rows;
        list.insertAdjacentElement('beforebegin', search);
      }
    });
  }

  // Нативные <input type="date/datetime-local/time"> неудобны (легко
  // промахнуться по сегменту года лишними цифрами) — заменяем на простую
  // маску без всплывающего календаря: цифры печатаются подряд, разделители
  // (. и :) подставляются сами по мере заполнения блока нужной длины.
  // Оригинальный input остаётся в DOM (name сохраняется, value — в исходном
  // формате, который сервер разбирает по позициям символов, см.
  // АнгелКартографияВнешнееAPI.ДатаПоля/ВремяПоля), просто скрывается
  // (type="hidden" — на generic-чтение в collectSettingsValues это не
  // влияет, там для этих полей и раньше срабатывала else-ветка, читающая
  // el.value как есть). Рядом — видимый текстовый input с маской в
  // человеческом порядке (день.месяц.год[ час:минута] / час:минута),
  // синхронизирующий обратно ISO-значение в оригинал.
  const DATE_MASKS = {
    date:     { segments: [2, 2, 4],          seps: ['.', '.'] },      // ДД.ММ.ГГГГ
    datetime: { segments: [2, 2, 4, 2, 2],    seps: ['.', '.', ' ', ':'] }, // ДД.ММ.ГГГГ ЧЧ:ММ
    time:     { segments: [2, 2],             seps: [':'] }            // ЧЧ:ММ
  };

  function maskLength(mask) {
    return mask.segments.reduce((a, b) => a + b, 0);
  }

  // Цифры -> строка с разделителями; разделитель подставляется сразу по
  // завершении блока нужной длины, не дожидаясь следующей цифры.
  function maskDigits(digits, mask) {
    let out = '';
    let pos = 0;
    for (let i = 0; i < mask.segments.length; i++) {
      const len = mask.segments[i];
      const chunk = digits.slice(pos, pos + len);
      if (!chunk) break;
      out += chunk;
      pos += len;
      if (chunk.length === len && i < mask.segments.length - 1) {
        out += mask.seps[i];
      }
    }
    return out;
  }

  // Цифры в порядке блоков маски (день,месяц,год[,час,минута] / час,минута)
  // -> ISO-строка для оригинального input. Пусто, пока не набран полный
  // комплект цифр (частично введённая дата не отправляется на сервер как
  // "какая-то" дата — только пусто или полностью заполненная).
  function digitsToISO(digits, kind) {
    if (kind === 'time') {
      return digits.length < 4 ? '' : `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
    }
    if (digits.length < 8) return '';
    const dd = digits.slice(0, 2), mm = digits.slice(2, 4), yyyy = digits.slice(4, 8);
    if (kind === 'date') return `${yyyy}-${mm}-${dd}`;
    if (digits.length < 12) return '';
    return `${yyyy}-${mm}-${dd}T${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
  }

  // Обратное преобразование — исходное значение input (пришедшее с сервера
  // в value="...") в строку цифр в порядке блоков маски, для первичной
  // отрисовки. Нераспознанное/пустое значение -> пустая строка.
  function isoToDigits(value, kind) {
    if (!value) return '';
    if (kind === 'time') {
      const m = /^(\d{2}):(\d{2})/.exec(value);
      return m ? m[1] + m[2] : '';
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
    if (!m) return '';
    const [, yyyy, mm, dd, hh, mi] = m;
    if (kind === 'datetime') return hh === undefined ? '' : dd + mm + yyyy + hh + mi;
    return dd + mm + yyyy;
  }

  function enhanceDateInputs(container) {
    container.querySelectorAll('input[type="date"], input[type="datetime-local"], input[type="time"]').forEach(original => {
      const kind = original.type === 'time' ? 'time' : (original.type === 'datetime-local' ? 'datetime' : 'date');
      const mask = DATE_MASKS[kind];
      const fullLength = maskLength(mask);

      const visible = document.createElement('input');
      visible.type = 'text';
      visible.inputMode = 'numeric';
      visible.autocomplete = 'off';
      visible.placeholder = kind === 'time' ? 'чч:мм' : (kind === 'datetime' ? 'дд.мм.гггг чч:мм' : 'дд.мм.гггг');
      visible.value = maskDigits(isoToDigits(original.value, kind), mask);

      original.type = 'hidden';
      original.insertAdjacentElement('afterend', visible);

      function sync() {
        const cursor = visible.selectionStart;
        const digitsBeforeCursor = visible.value.slice(0, cursor).replace(/\D/g, '').length;

        const digits = visible.value.replace(/\D/g, '').slice(0, fullLength);
        const masked = maskDigits(digits, mask);
        visible.value = masked;
        original.value = digitsToISO(digits, kind);
        original.dispatchEvent(new Event('change', { bubbles: true }));

        let seen = 0, pos = masked.length;
        for (let i = 0; i < masked.length; i++) {
          if (/\d/.test(masked[i])) {
            seen++;
            if (seen === digitsBeforeCursor) { pos = i + 1; break; }
          }
        }
        if (masked[pos] && !/\d/.test(masked[pos])) pos++; // встать после разделителя, а не перед ним
        visible.setSelectionRange(pos, pos);
      }

      visible.addEventListener('input', sync);

      // Забой сразу за авто-подставленным разделителем должен стирать цифру
      // перед ним, а не сам разделитель (тот всё равно пересоберётся из
      // цифр) — иначе backspace выглядел бы так, будто ничего не происходит.
      visible.addEventListener('keydown', e => {
        if (e.key !== 'Backspace' || visible.selectionStart !== visible.selectionEnd) return;
        const pos = visible.selectionStart;
        if (pos > 0 && !/\d/.test(visible.value[pos - 1])) {
          e.preventDefault();
          visible.value = visible.value.slice(0, pos - 2) + visible.value.slice(pos - 1);
          visible.setSelectionRange(pos - 2, pos - 2);
          sync();
        }
      });
    });
  }

  // Сбрасывает все поля текущей формы настроек в пустое значение — тем же
  // generic-обходом [name]-полей по HTML-типу, что и collectSettingsValues/
  // applySettingsDependencies, не зная заранее, какие именно поля есть у слоя
  // (или отчёта). Не отправляет ничего на сервер сама — просто очищает форму,
  // «Применить» всё ещё нужно нажать отдельно (симметрично тому, что «Отмена»
  // просто закрывает модалку, не сохраняя). Завязана на фиксированный
  // #settingsBody — общую модалку настроек (см. buildChrome() в map.js),
  // которую делят между собой панель слоёв и вкладка «Отчёты».
  function clearSettingsForm() {
    const body = document.getElementById('settingsBody');
    body.querySelectorAll('[name]').forEach(el => {
      if (el.type === 'checkbox') {
        el.checked = false;
      } else if (el.tagName === 'SELECT' && el.multiple) {
        Array.from(el.options).forEach(o => { o.selected = false; });
        // enhanceMultiSelects прячет сам select и рисует рядом чек-лист
        // (.settings-form__checklist) — он не отражает option.selected сам по
        // себе, снимаем отметки в нём отдельно. Берём его по ссылке
        // select._checklist, а не по nextElementSibling: у длинных списков
        // (ГРЗ) между select и чек-листом стоит ещё строка поиска.
        const list = el._checklist;
        if (list) {
          list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
          // Заодно снимаем фильтр поиска: иначе после очистки список
          // остаётся показанным частично, и кажется, что часть строк пропала.
          if (list._search) {
            list._search.value = '';
            (list._rows || []).forEach(({ row }) => row.classList.remove('is-hidden'));
          }
        }
      } else {
        el.value = '';
        // enhanceDateInputs прячет оригинальный date/time input (type="hidden")
        // и рисует рядом с ним замаскированный текстовый — держим оба пустыми,
        // иначе видимая маска продолжит показывать старые цифры.
        if (el.type === 'hidden' && el.nextElementSibling && el.nextElementSibling.tagName === 'INPUT') {
          el.nextElementSibling.value = '';
        }
      }
    });
    applySettingsDependencies(body);
  }

  // Generic-сборка значений формы — читает [name]-поля внутри #settingsBody
  // по их HTML-типу, не зная заранее, какие именно поля есть у слоя (или отчёта).
  function collectSettingsValues() {
    const values = {};
    document.querySelectorAll('#settingsBody [name]').forEach(el => {
      if (el.type === 'checkbox') {
        values[el.name] = el.checked;
      } else if (el.tagName === 'SELECT' && el.multiple) {
        values[el.name] = Array.from(el.selectedOptions).map(o => o.value);
      } else if (el.type === 'number') {
        values[el.name] = el.value === '' ? null : Number(el.value);
      } else {
        values[el.name] = el.value;
      }
    });
    return values;
  }

  // =====================================================================
  //  Общий контроллер модалки #settingsOverlay/#settingsModal (см. buildChrome()
  //  в map.js) — открытие/закрытие/применение не завязаны на конкретный слой или
  //  отчёт, а работают через descriptor { title, load(), save(values), onApplied() },
  //  который передаёт вызывающая сторона (map.js: openLayerSettings, reports.js:
  //  openReportSettings). Кнопки модалки (#settingsApply/#settingsCancel/...)
  //  привязываются к applySettings/closeSettings ОДИН раз в buildChrome() —
  //  без этого у панели слоёв и вкладки «Отчёты» были бы два независимых
  //  обработчика клика по одной и той же кнопке «Применить», конфликтующих
  //  за то, чей именно сохранённый слой/отчёт сейчас в модалке.
  let current = null;

  async function openSettings(descriptor) {
    current = descriptor;
    document.getElementById('settingsTitle').textContent = descriptor.title;
    document.getElementById('settingsError').textContent = '';
    document.getElementById('settingsBody').innerHTML = `<div class="detail-empty"><p>Загрузка…</p></div>`;
    document.getElementById('settingsOverlay').classList.add('is-open');
    // Слои с большим числом перенесённых нативных фильтров (ДТП/Дислокации/УчасткиДороги/...)
    // не помещаются в стандартную ширину модалки — descriptor.wide переключает на
    // двухколоночную раскладку (см. .modal--wide/.settings-form--grid в css/styles.css).
    // Сбрасывается на каждое открытие, чтобы обычные (узкие) слои/отчёты не унаследовали
    // класс от предыдущей открытой модалки.
    document.getElementById('settingsModal').classList.toggle('modal--wide', !!descriptor.wide);

    try {
      const data = await descriptor.load();
      if (current !== descriptor) return; // пользователь успел закрыть/открыть другую модалку
      const body = document.getElementById('settingsBody');
      body.innerHTML = data.html || `<div class="detail-empty"><p>Настроек нет</p></div>`;
      if (data.title) document.getElementById('settingsTitle').textContent = data.title;
      enhanceMultiSelects(body);
      enhanceDateInputs(body);
      wireSettingsDependencies(body);
      wireExclusiveCheckboxes(body);
    } catch (e) {
      console.error('Ошибка загрузки настроек', e);
      if (current === descriptor) {
        document.getElementById('settingsBody').innerHTML =
          `<div class="detail-empty"><p>Не удалось загрузить настройки</p></div>`;
      }
    }
  }

  function closeSettings() {
    current = null;
    document.getElementById('settingsOverlay').classList.remove('is-open');
  }

  async function applySettings() {
    if (!current) return;
    const descriptor = current;
    const btn = document.getElementById('settingsApply');
    const errEl = document.getElementById('settingsError');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Сохранение…';
    try {
      const res = await descriptor.save(collectSettingsValues());
      if (res && res.ok === false) {
        throw new Error(res.error || 'Сервер отклонил настройки');
      }
      closeSettings();
      if (descriptor.onApplied) await descriptor.onApplied();
    } catch (e) {
      console.error('Ошибка сохранения настроек', e);
      errEl.textContent = 'Не удалось сохранить настройки';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Применить';
    }
  }

  return {
    applySettingsDependencies,
    wireSettingsDependencies,
    wireExclusiveCheckboxes,
    enhanceMultiSelects,
    enhanceDateInputs,
    clearSettingsForm,
    collectSettingsValues,
    openSettings,
    closeSettings,
    applySettings
  };
})();

window.SettingsForm = SettingsForm;
