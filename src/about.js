// Розділ «Про застосунок та інструкція» — тексти трьома мовами (статична розмітка, без даних користувача).

const keys = (rows) => `<table class="keys">${rows.map((r) => `<tr>${r.map(([k, d]) => `<td>${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join(' ')}</td><td>${d}</td>`).join('')}</tr>`).join('')}</table>`;

export default {
  uk: {
    title: 'Про застосунок та інструкція',
    dev: 'Розробник',
    version: 'Версія',
    link: 'Інструкція…',
    html: `
<p class="lead">Переглядач креслень <b>CAPLAN</b> (Cremer) у 3D. Працює в браузері на комп'ютері й телефоні.
Файли обробляються лише на вашому пристрої й нікуди не надсилаються.</p>

<h3>Формати</h3>
<ul>
  <li><b>.CPZ</b> — проєкт CAPLAN (архів із файлами .CP і .L): точки, лінії, шари з кольорами.</li>
  <li><b>.CP + .L / .KOR</b> — ті самі файли окремо (виберіть їх разом).</li>
  <li><b>.DXF</b> (ASCII) — лінії, 2D/3D-полілінії, точки, дуги й кола, тексти, блоки з атрибутами, 3D-грані (DGM). Кирилиця й умлаути підтримуються.</li>
  <li><b>DWG</b> поки не підтримується — збережіть креслення як DXF.</li>
</ul>

<h3>Відкриття файлу</h3>
<ul>
  <li>Кнопка «Відкрити файл…» або перетягніть файл у вікно.</li>
  <li>На телефоні: кнопка «Відкрити файл…» на початковому екрані, а коли файл уже відкрито — меню ☰ → «Відкрити файл…».</li>
</ul>

<h3>Навігація</h3>
<ul>
  <li><b>Миша:</b> ліва кнопка — обертання, права — зсув, коліщатко — масштаб до курсора.</li>
  <li><b>Дотики:</b> один палець — обертання, два — масштаб і зсув.</li>
  <li><b>Види:</b> Зверху, Спереду (з півдня), Збоку (зі сходу), 3D (загальний косий вигляд). «Вписати» показує всі видимі шари. На ПК клавіша <kbd>O</kbd> вмикає вигляд без перспективи — зручно для плану.</li>
  <li>Компас (на ПК — унизу ліворуч, на телефоні — угорі праворуч): <b>E</b> — схід, <b>N</b> — північ, <b>H</b> — висота.</li>
</ul>

<h3>Точки й вимірювання</h3>
<ul>
  <li>Клік (дотик) на точці показує назву, координати Rechtswert / Hochwert / Höhe, шар і лінії з довжиною в плані та 3D. На телефоні координати — у рядку внизу екрана.</li>
  <li>«Виміряти»: клікніть дві точки — похила й горизонтальна відстань, перевищення ΔH, ухил і дирекційний кут (° та gon). У DXF можна прив'язуватися до вершин ліній.</li>
</ul>

<h3>Шари (Objektart)</h3>
<ul>
  <li>Галочка вмикає чи вимикає шар; подвійний клік (на ПК) — показати лише цей шар; «усі» / «жодного».</li>
  <li>Назви шарів беруться з каталогу Objektart CAPLAN (ObjType.DAT) і показуються вибраною мовою. Шари DXF із CAPLAN (L_, S_, H_ + назва шару) розпізнаються так само.</li>
</ul>

<h3>Відображення</h3>
<ul>
  <li><b>Лінії, Точки, Тексти, Сітка</b> — показ відповідних елементів.</li>
  <li><b>Типи ліній</b> — штрихові й штрихпунктирні лінії з DXF; об'єкти DXF мають власні кольори, як у кресленні.</li>
  <li><b>Назви точок, Висоти</b> — підписи біля точок, без накладання одне на одне.</li>
  <li><b>2D-об'єкти</b> — об'єкти без висоти (H = 0) розміщуються на рівні найнижчої точки.</li>
  <li><b>Проєкції</b> — вертикальні лінії від точок до сітки.</li>
  <li><b>Колір</b> — за шаром або за висотою; <b>Z ×</b> — перебільшення висот; товщина ліній і розмір точок.</li>
  <li><b>PNG</b> — зберегти поточний вигляд як зображення. Тема — світла або темна.</li>
</ul>

<h3>Гарячі клавіші</h3>
${keys([
  [['F', 'вписати'], ['O', 'орто / перспектива']],
  [['T 1', 'зверху'], ['M', 'вимірювання']],
  [['2', 'спереду'], ['N', 'назви точок']],
  [['3', 'збоку'], ['H', 'висоти']],
  [['4', '3D-вигляд'], ['Esc', 'скинути / закрити']],
])}

<h3>На телефоні</h3>
<ul>
  <li>Інструменти — на нижній панелі: <b>Вид</b> (Зверху / Спереду / Збоку / 3D), <b>Вписати</b>, <b>Виміряти</b>, <b>PNG</b>.</li>
  <li>Шари й налаштування — у панелі за кнопкою ☰ або натисканням на назву файлу вгорі.</li>
  <li>У меню браузера виберіть «Додати на головний екран» — застосунок з'явиться з власною іконкою (для роботи потрібен інтернет).</li>
</ul>

<p class="foot">Мова інтерфейсу — перемикач UA · DE · EN угорі панелі.</p>`,
  },

  de: {
    title: 'Über die App und Anleitung',
    dev: 'Entwickler',
    version: 'Version',
    link: 'Anleitung…',
    html: `
<p class="lead">3D-Viewer für <b>CAPLAN</b>-Zeichnungen (Cremer). Läuft im Browser auf PC und Smartphone.
Dateien werden nur auf Ihrem Gerät verarbeitet und nirgendwohin gesendet.</p>

<h3>Formate</h3>
<ul>
  <li><b>.CPZ</b> — CAPLAN-Projekt (Archiv mit .CP und .L): Punkte, Linien, Ebenen mit Farben.</li>
  <li><b>.CP + .L / .KOR</b> — dieselben Dateien einzeln (gemeinsam auswählen).</li>
  <li><b>.DXF</b> (ASCII) — Linien, 2D/3D-Polylinien, Punkte, Bögen und Kreise, Texte, Blöcke mit Attributen, 3D-Flächen (DGM). Umlaute und Kyrillisch werden unterstützt.</li>
  <li><b>DWG</b> wird noch nicht unterstützt — Zeichnung bitte als DXF speichern.</li>
</ul>

<h3>Datei öffnen</h3>
<ul>
  <li>Schaltfläche „Datei öffnen…“ oder Datei ins Fenster ziehen.</li>
  <li>Auf dem Smartphone: Schaltfläche „Datei öffnen…“ auf dem Startbildschirm, bei geöffneter Datei — Menü ☰ → „Datei öffnen…“.</li>
</ul>

<h3>Navigation</h3>
<ul>
  <li><b>Maus:</b> linke Taste — drehen, rechte — verschieben, Mausrad — zoomen zum Cursor.</li>
  <li><b>Touch:</b> ein Finger — drehen, zwei — zoomen und verschieben.</li>
  <li><b>Ansichten:</b> Oben, Vorne (von Süden), Seite (von Osten), 3D (schräge Gesamtansicht). „Einpassen“ zeigt alle sichtbaren Ebenen. Am PC schaltet die Taste <kbd>O</kbd> die Ansicht ohne Perspektive ein — ideal für den Lageplan.</li>
  <li>Kompass (am PC unten links, auf dem Smartphone oben rechts): <b>E</b> — Osten, <b>N</b> — Norden, <b>H</b> — Höhe.</li>
</ul>

<h3>Punkte und Messen</h3>
<ul>
  <li>Klick (Tippen) auf einen Punkt zeigt Name, Rechtswert / Hochwert / Höhe, Ebene und Linien mit Länge im Grundriss und in 3D. Auf dem Smartphone stehen die Koordinaten in der Leiste unten.</li>
  <li>„Messen“: zwei Punkte anklicken — Schräg- und Horizontalstrecke, Höhenunterschied ΔH, Neigung und Richtungswinkel (° und gon). In DXF kann an Linien-Stützpunkte gefangen werden.</li>
</ul>

<h3>Ebenen (Objektart)</h3>
<ul>
  <li>Häkchen blendet eine Ebene ein oder aus; Doppelklick (am PC) — nur diese Ebene; „alle“ / „keine“.</li>
  <li>Ebenennamen stammen aus dem CAPLAN-Objektartenkatalog (ObjType.DAT) und erscheinen in der gewählten Sprache. DXF-Ebenen aus CAPLAN (L_, S_, H_ + Layername) werden ebenso erkannt.</li>
</ul>

<h3>Darstellung</h3>
<ul>
  <li><b>Linien, Punkte, Texte, Raster</b> — Anzeige der jeweiligen Elemente.</li>
  <li><b>Linientypen</b> — Strich- und Strichpunktlinien aus DXF; DXF-Objekte behalten ihre eigenen Farben wie in der Zeichnung.</li>
  <li><b>Punktnamen, Höhen</b> — Beschriftung an den Punkten, ohne Überlappung.</li>
  <li><b>2D-Objekte</b> — Objekte ohne Höhe (H = 0) werden auf Höhe des tiefsten Punktes dargestellt.</li>
  <li><b>Lote</b> — senkrechte Linien von den Punkten zum Raster.</li>
  <li><b>Farbe</b> — nach Ebene oder nach Höhe; <b>Z ×</b> — Überhöhung; Linienstärke und Punktgröße.</li>
  <li><b>PNG</b> — aktuelle Ansicht als Bild speichern. Design — hell oder dunkel.</li>
</ul>

<h3>Tastenkürzel</h3>
${keys([
  [['F', 'einpassen'], ['O', 'Ortho / Perspektive']],
  [['T 1', 'Draufsicht'], ['M', 'messen']],
  [['2', 'vorne'], ['N', 'Punktnamen']],
  [['3', 'Seite'], ['H', 'Höhen']],
  [['4', '3D-Ansicht'], ['Esc', 'zurücksetzen / schließen']],
])}

<h3>Auf dem Smartphone</h3>
<ul>
  <li>Werkzeuge — in der unteren Leiste: <b>Ansicht</b> (Oben / Vorne / Seite / 3D), <b>Einpassen</b>, <b>Messen</b>, <b>PNG</b>.</li>
  <li>Ebenen und Einstellungen — im Bereich hinter der Schaltfläche ☰ oder durch Tippen auf den Dateinamen oben.</li>
  <li>Im Browsermenü „Zum Startbildschirm hinzufügen“ wählen — die App erscheint mit eigenem Symbol (Internetverbindung erforderlich).</li>
</ul>

<p class="foot">Sprache der Oberfläche — Umschalter UA · DE · EN oben im Bereich.</p>`,
  },

  en: {
    title: 'About the app & instructions',
    dev: 'Developer',
    version: 'Version',
    link: 'Instructions…',
    html: `
<p class="lead">3D viewer for <b>CAPLAN</b> (Cremer) drawings. Runs in the browser on desktop and phone.
Files are processed only on your device and are never uploaded.</p>

<h3>Formats</h3>
<ul>
  <li><b>.CPZ</b> — CAPLAN project (archive with .CP and .L): points, lines, layers with colors.</li>
  <li><b>.CP + .L / .KOR</b> — the same files separately (select them together).</li>
  <li><b>.DXF</b> (ASCII) — lines, 2D/3D polylines, points, arcs and circles, texts, blocks with attributes, 3D faces (DTM). Umlauts and Cyrillic are supported.</li>
  <li><b>DWG</b> is not supported yet — save the drawing as DXF.</li>
</ul>

<h3>Opening a file</h3>
<ul>
  <li>Use “Open file…” or drag the file into the window.</li>
  <li>On a phone: the “Open file…” button on the start screen, or menu ☰ → “Open file…” once a file is open.</li>
</ul>

<h3>Navigation</h3>
<ul>
  <li><b>Mouse:</b> left button — rotate, right — pan, wheel — zoom to cursor.</li>
  <li><b>Touch:</b> one finger — rotate, two — zoom and pan.</li>
  <li><b>Views:</b> Top, Front (from the south), Side (from the east), 3D (oblique overview). “Fit” frames all visible layers. On a PC the <kbd>O</kbd> key switches to a view without perspective — handy for plan view.</li>
  <li>Compass (bottom left on a PC, top right on a phone): <b>E</b> — east, <b>N</b> — north, <b>H</b> — height.</li>
</ul>

<h3>Points and measuring</h3>
<ul>
  <li>Click (tap) a point to see its name, Rechtswert / Hochwert / Höhe coordinates, layer and lines with plan and 3D length. On a phone the coordinates appear in the bar at the bottom.</li>
  <li>“Measure”: click two points — slope and horizontal distance, height difference ΔH, grade and bearing (° and gon). In DXF you can snap to line vertices.</li>
</ul>

<h3>Layers (Objektart)</h3>
<ul>
  <li>The checkbox shows or hides a layer; double-click (on a PC) — show only that layer; “all” / “none”.</li>
  <li>Layer names come from the CAPLAN Objektart catalog (ObjType.DAT) and are shown in the selected language. CAPLAN DXF layers (L_, S_, H_ + layer name) are recognised too.</li>
</ul>

<h3>Display</h3>
<ul>
  <li><b>Lines, Points, Texts, Grid</b> — show the corresponding elements.</li>
  <li><b>Linetypes</b> — dashed and dash-dot lines from DXF; DXF objects keep their own colors as in the drawing.</li>
  <li><b>Point names, Heights</b> — labels next to points, without overlaps.</li>
  <li><b>2D objects</b> — objects without height (H = 0) are placed at the level of the lowest point.</li>
  <li><b>Drop lines</b> — vertical lines from points down to the grid.</li>
  <li><b>Color</b> — by layer or by height; <b>Z ×</b> — vertical exaggeration; line width and point size.</li>
  <li><b>PNG</b> — save the current view as an image. Theme — light or dark.</li>
</ul>

<h3>Keyboard shortcuts</h3>
${keys([
  [['F', 'fit'], ['O', 'ortho / perspective']],
  [['T 1', 'top'], ['M', 'measure']],
  [['2', 'front'], ['N', 'point names']],
  [['3', 'side'], ['H', 'heights']],
  [['4', '3D view'], ['Esc', 'reset / close']],
])}

<h3>On a phone</h3>
<ul>
  <li>Tools are in the bottom bar: <b>View</b> (Top / Front / Side / 3D), <b>Fit</b>, <b>Measure</b>, <b>PNG</b>.</li>
  <li>Layers and settings are in the panel behind the ☰ button, or tap the file name at the top.</li>
  <li>Choose “Add to Home screen” in the browser menu — the app gets its own icon (an internet connection is required).</li>
</ul>

<p class="foot">Interface language — the UA · DE · EN switch at the top of the panel.</p>`,
  },
};
