/*
 * emccpre.js: one of the Javascript components of an Emscripten-based
 * web/Javascript front end for Puzzles.
 *
 * The other parts of this system live in emcc.c and emcclib.js. It
 * also depends on being run in the context of a web page containing
 * an appropriate collection of bits and pieces (a canvas, some
 * buttons and links etc), which is generated for each puzzle by the
 * script html/jspage.pl.
 *
 * This file contains the Javascript code which is prefixed unmodified
 * to Emscripten's output via the --pre-js option. It declares all our
 * global variables, and provides the puzzle init function and a
 * couple of other helper functions.
 */

// Because this script is run using <script defer>, we can guarantee
// that the DOM is complete, so it's OK to look up elements
// immediately.  On the other hand, the Emscripten runtime hasn't
// started yet, so Module.cwrap isn't safe.

// Error handler to make any failures from here on visible to the
// user, maybe.
window.addEventListener("error", function (e) {
    alert(e.message);
});

// To avoid flicker while doing complicated drawing, we use two
// canvases, the same size. One is actually on the web page, and the
// other is off-screen. We do all our drawing on the off-screen one
// first, and then copy rectangles of it to the on-screen canvas in
// response to draw_update() calls by the game backend.
var onscreen_canvas, offscreen_canvas;

// A persistent drawing context for the offscreen canvas, to save
// requesting it for each individual graphics operation.
var ctx;

// Bounding rectangle for the copy to the onscreen canvas that will be
// done at drawing end time. Updated by js_canvas_draw_update and used
// by js_canvas_end_draw.
var update_xmin, update_xmax, update_ymin, update_ymax;

// Colour strings to use when drawing, to save converting them from C
// every time.
var colours = [];

// Module object for Emscripten. We fill in these parameters to ensure
// that when main() returns nothing will get cleaned up so we remain
// able to call the puzzle's various callbacks.
//
// Page loading order:
//
// 1. The browser starts reading *.html (which comes from jspage.pl)
// 2. It finds the <script> tag.  This is marked defer, so the
//    browser will start fetching and parsing it, but not execute it
//    until the page has loaded.
//
// Now the browser is loading *.html and *.js in parallel.  The
// html is rendered as we go, and the js is deferred.
//
// 3. The HTML finishes loading.  The browser is about to fire the
//    `DOMContentLoaded` event (ie `onload`) but before that, it
//    actually runs the deferred JS.  This consists of
//
//    (i) emccpre.js (this file).  This sets up various JS variables
//      including the emscripten Module object, which includes the
//      environment variables and argv seen by main().
//
//    (ii) emscripten's JS.  This starts the WASM loading.
//
// When this JS execution is complete, the browser fires the `onload`
// event.  This is ignored.  It continues loading the WASM.
//
// 4. The WASM loading and initialisation completes.  Emscripten's
//    runtime calls the C `main` to actually start the puzzle.  It
//    then calls initPuzzle, which:
//
//      (a) finds various DOM elements and bind them to variables,
//      which depends on the HTML having loaded (it has).
//
//      (b) makes various `cwrap` calls into the emscripten module to
//      set up hooks; this depends on the emscripten JS having been
//      loaded (it has).

var Module = {
    'preRun': function() {
        // Merge environment variables from HTML script elements.
        // This means you can add something like this to the HTML:
        // <script id="environment" type="application/json">
        //   { "LOOPY_DEFAULT": "20x10t11dh" }
        // </script>
        var envscript, k, v;
        for (envscript of document.querySelectorAll(
            "script#environment, script.environment"))
            for ([k, v] of
                 Object.entries(JSON.parse(envscript.textContent)))
                ENV[k] = v;
    },
    // Pass argv[1] as the fragment identifier (so that permalinks of
    // the form puzzle.html#game-id can launch the specified id).
    'arguments': [decodeURIComponent(location.hash)],
    'noExitRuntime': true
};

// Variables used by js_canvas_find_font_midpoint().
var midpoint_test_str = "ABCDEFGHIKLMNOPRSTUVWXYZ0123456789";
var midpoint_cache = [];

// Variables used by js_activate_timer() and js_deactivate_timer().
var timer;
var timer_reference;

// void timer_callback(double tplus);
//
// Called every frame while timing is active.
var timer_callback;

// The status bar object, if we have one.
var statusbar = document.getElementById("statusbar");

// Currently live blitters. We keep an integer id for each one on the
// JS side; the C side, which expects a blitter to look like a struct,
// simply defines the struct to contain that integer id.
var blittercount = 0;
var blitters = new Map();

// State for the dialog-box mechanism. dlg_dimmer and dlg_form are the
// page-darkening overlay and the actual dialog box respectively;
// dlg_return_funcs is a list of JS functions to be called when the OK
// button is pressed, to pass the results back to C.
var dlg_dimmer = null, dlg_form = null;
var dlg_return_funcs = null;

// void dlg_return_sval(int index, const char *val);
// void dlg_return_ival(int index, int val);
//
// C-side entry points called by functions in dlg_return_funcs, to
// pass back the final value in each dialog control.
var dlg_return_sval, dlg_return_ival;

// Callback for reading from a savefile.  This will be filled in with
// a suitable closure by the JS loading code and called by
// js_savefile_read().  This assumes that only one file can be in the
// process of loading at a time.
var savefile_read_callback;

// void prefs_load_callback(midend *me, const char *prefs);
//
// Callback for passing in preferences data retrieved from localStorage.
var prefs_load_callback;

// The <ul> object implementing the game-type drop-down, and a list of
// the sub-lists inside it. Used by js_add_preset().
var gametypelist = document.getElementById("gametype");
var gametypesubmenus = [gametypelist];

// C entry point for miscellaneous events.
var command;

// The <form> encapsulating the menus.  Used by
// js_get_selected_preset() and js_select_preset().
var menuform = document.getElementById("gamemenu");

// The two anchors used to give permalinks to the current puzzle. Used
// by js_update_permalinks().
var permalink_seed = document.getElementById("permalink-seed");
var permalink_desc = document.getElementById("permalink-desc");

// The various buttons. Undo and redo are used by js_enable_undo_redo().
var specific_button = document.getElementById("specific");
var random_button = document.getElementById("random");
var prefs_button = document.getElementById("prefs");
var new_button = document.getElementById("new");
var restart_button = document.getElementById("restart");
var undo_button = document.getElementById("undo");
var redo_button = document.getElementById("redo");
var solve_button = document.getElementById("solve");
var save_button = document.getElementById("save");
var load_button = document.getElementById("load");

// A div element enclosing both the puzzle and its status bar, used
// for positioning the resize handle.
var resizable_div = document.getElementById("resizable");

// Alternatively, an extrinsically sized div that we will size the
// puzzle to fit.
var containing_div = document.getElementById("puzzlecanvascontain");

// The current front-end scale factor.  This is how many logical
// pixels (as seen by the mid end and back end) there are to one
// physical pixel in the canvas.  It's applied as a scaling to the
// graphics context and also used to adjust co-ordinates for things
// that don't pass through that scaling.
//
// In order to keep pixel boundaries where the back end expects them
// to be, this is always an integer and at least 1, so it's not
// necessarily the same as window.devicePixelRatio.
var fe_scale = 1;

// Helper function to find the absolute position of a given DOM
// element on a page, by iterating upwards through the DOM finding
// each element's offset from its parent, and thus calculating the
// page-relative position of the target element.
function element_coords(element) {
    var ex = 0, ey = 0;
    while (element.offsetParent) {
        ex += element.offsetLeft;
        ey += element.offsetTop;
        element = element.offsetParent;
    }
    return {x: ex, y:ey};
}

// Helper function which is passed a mouse event object and a DOM
// element, and returns the coordinates of the mouse event relative to
// the top left corner of the element by subtracting element_coords
// from event.page{X,Y}.
function relative_mouse_coords(event, element) {
    var ecoords = element_coords(element);
    return {x: event.pageX - ecoords.x,
            y: event.pageY - ecoords.y};
}

// Higher-level mouse helper function to specifically map mouse
// coordinates into the coordinates on a canvas that appear under it.
// This depends on the details of how a canvas gets scaled by CSS.
function canvas_mouse_coords(event, element) {
    var rcoords = relative_mouse_coords(event, element);
    // Assume that the CSS object-fit property is "fill" (the default).
    var xscale = element.width / element.offsetWidth / fe_scale;
    var yscale = element.height / element.offsetHeight / fe_scale;
    return {x: rcoords.x * xscale, y: rcoords.y * yscale}
}

// Board elements: the parts of the board a puzzle describes through
// draw_element() (see devel.but), such as its tiles, kept here so that
// the page can present the board to assistive technology. A puzzle
// that doesn't call draw_element() leaves all of this unused.
var element_kinds = { 1: "board", 2: "space", 3: "tile" };
var board_elements = {
    // The puzzle, from js_puzzle_info(): { name, can_solve,
    // one_key_shortcuts }.
    puzzle: null,
    // The model as of the latest redraw that ended at rest, or null if
    // the puzzle has sent no elements. The board comes first, then the
    // rest in reading order. Each element is { kind, id, label, rect,
    // page }: rect is in the puzzle's drawing coordinates, and page is
    // the same rectangle in page coordinates, where the canvas is now.
    published: null,
    // The game's status (positive once solved) at that redraw.
    status: 0,
    // Whether the latest mouse press had no effect: { no_effect }.
    press_result: null,
    // Functions called as f(published, status) on every publish.
    listeners: [],
    // The elements as the calls since the last board describe them,
    // which may be in between positions during a move animation, each
    // with the order it was first seen in.
    recorded: [],
    next_order: 0
};

function rect_contains(outer, inner) {
    return outer.x <= inner.x && outer.y <= inner.y &&
        inner.x + inner.w <= outer.x + outer.w &&
        inner.y + inner.h <= outer.y + outer.h;
}

// Apply one draw_element() call by devel.but's identity rules: kind
// and id identify an element, a board starts a new board, the latest
// call for an element wins, and a covered element is gone.
function board_element_record(kind, id, label, x, y, w, h) {
    if (board_overlay === null)
        board_overlay_create();
    var element = { kind: element_kinds[kind] || kind, id: id,
                    label: label, rect: { x: x, y: y, w: w, h: h } };
    var same = function(r) {
        return r.element.kind === element.kind && r.element.id === id;
    };
    if (element.kind === "board") {
        board_elements.recorded = [{ element: element, order: 0 }];
        board_elements.next_order = 1;
        return;
    }
    board_elements.recorded = board_elements.recorded.filter(function(r) {
        return same(r) || r.element.rect.w <= 0 || r.element.rect.h <= 0 ||
            !rect_contains(element.rect, r.element.rect);
    });
    var existing = board_elements.recorded.find(same);
    if (existing)
        existing.element = element;
    else
        board_elements.recorded.push(
            { element: element, order: board_elements.next_order++ });
}

// Map a rectangle in the puzzle's drawing coordinates to page
// coordinates: the reverse of canvas_mouse_coords. The canvas's
// width in device pixels over its CSS width accounts for the device
// pixel ratio, and fe_scale for the part of it applied as scaling.
function canvas_page_rect(rect) {
    var origin = element_coords(onscreen_canvas);
    var xscale = onscreen_canvas.offsetWidth * fe_scale / onscreen_canvas.width;
    var yscale = onscreen_canvas.offsetHeight * fe_scale / onscreen_canvas.height;
    return { x: origin.x + rect.x * xscale, y: origin.y + rect.y * yscale,
             w: rect.w * xscale, h: rect.h * yscale };
}

// Called after every redraw. Only at rest does the model describe the
// board as it is, so only then is it published. A completion flash
// moves nothing, and counts as at rest.
function board_elements_end_draw(at_rest, status) {
    if (board_elements.recorded.length === 0)
        return;
    board_announce_drawn();
    if (!at_rest)
        return;
    var sorted = board_elements.recorded.slice().sort(function(a, b) {
        var x = a.element, y = b.element;
        if ((x.kind === "board") !== (y.kind === "board"))
            return x.kind === "board" ? -1 : 1;
        if (x.rect.y !== y.rect.y) return x.rect.y - y.rect.y;
        if (x.rect.x !== y.rect.x) return x.rect.x - y.rect.x;
        return a.order - b.order;
    });
    board_elements.published = sorted.map(function(r) {
        var e = r.element;
        var rect = { x: e.rect.x, y: e.rect.y, w: e.rect.w, h: e.rect.h };
        return Object.defineProperty(
            { kind: e.kind, id: e.id, label: e.label, rect: rect }, "page",
            { enumerable: true,
              get: function() { return canvas_page_rect(rect); } });
    });
    board_elements.status = status;
    board_overlay_update(board_elements.published);
    for (var i = 0; i < board_elements.listeners.length; i++)
        board_elements.listeners[i](board_elements.published, status);
    board_announce_published(board_elements.published, status);
}

// The accessible board: a labelled table of transparent buttons laid
// over the canvas, for assistive technology, with a row for each row of
// squares and a cell for each square holding its button. A table is
// what lets a screen reader move up and down as well as along a row;
// unlike a grid, it has no keys of its own, so the canvas keeps the
// arrow keys. A button stands for a square, not for what's on it, so
// the same buttons stay in the same cells and only their labels change.
// Pointer events pass through to the canvas, and the canvas stays the
// only Tab stop. It's created on the first board element, so a puzzle
// that sends none leaves the page as it was.
var board_overlay = null;

// Called from initPuzzle with a function pressing the left button at a
// point in the puzzle's drawing coordinates, through the mouse path.
var board_square_press = null;

function board_overlay_create() {
    var parent = onscreen_canvas.parentNode;
    var table = document.createElement("div");
    table.id = "puzzleboard";
    table.setAttribute("role", "table");
    parent.insertBefore(table, onscreen_canvas.nextSibling);

    var hint = document.createElement("div");
    hint.id = "puzzlekeyhint";
    hint.className = "visually-hidden";
    hint.textContent = "Use the arrow keys, or press a square on the board.";
    parent.insertBefore(hint, table.nextSibling);
    onscreen_canvas.setAttribute("aria-describedby", hint.id);

    board_overlay = { table: table, hint: hint, row_elements: [] };
    board_announce_create();
    board_overlay_name();
    window.addEventListener("resize", board_overlay_fit);
}

// Name the canvas and the board after the puzzle.
function board_overlay_name() {
    var puzzle = board_elements.puzzle;
    if (board_overlay === null || puzzle === null)
        return;
    onscreen_canvas.setAttribute("aria-label",
                                 puzzle.name + ", keyboard play");
    if (board_overlay.columns)
        board_overlay.table.setAttribute(
            "aria-label", puzzle.name + " board, " + board_overlay.columns +
                " by " + board_overlay.rows);
}

// Lay the table over the canvas's box. Its rows and cells are placed
// in percentages of it, so they follow. The size is the one
// js_canvas_set_size gives the canvas, which holds even while the
// puzzle is still hidden; the position is measured, so it's measured
// again once the puzzle is shown.
function board_overlay_fit() {
    if (board_overlay === null)
        return;
    var style = board_overlay.table.style;
    var dpr = window.devicePixelRatio || 1;
    style.left = onscreen_canvas.offsetLeft + "px";
    style.top = onscreen_canvas.offsetTop + "px";
    style.width = onscreen_canvas.width / dpr + "px";
    style.height = onscreen_canvas.height / dpr + "px";
}

function board_square_click(event) {
    var rect = this.board_rect;
    if (board_square_press !== null && rect)
        board_square_press(Math.floor(rect.x + rect.w / 2),
                           Math.floor(rect.y + rect.h / 2),
                           this.board_element);
}

function rect_intersects(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w &&
        a.y < b.y + b.h && b.y < a.y + a.h;
}

// How a square is said: its label, "Empty" for the space, or "Tile"
// for a tile without one.
function board_spoken_label(element) {
    return element.kind === "space" ? "Empty" :
        element.label !== null ? element.label : "Tile";
}

// Where each space and tile of a published model sits on the board,
// by row and column counting from 1, in reading order. Each distinct
// left edge on the board is a column, and each distinct top edge a
// row, so this needs no puzzle's rules.
function board_layout(published) {
    var board = published[0].kind === "board" ? published[0].rect : null;
    var pieces = published.filter(function(e) {
        return (e.kind === "space" || e.kind === "tile") &&
            (board === null || rect_intersects(board, e.rect));
    });
    var edges = function(axis) {
        var seen = [];
        pieces.forEach(function(e) {
            if (seen.indexOf(e.rect[axis]) < 0) seen.push(e.rect[axis]);
        });
        return seen.sort(function(a, b) { return a - b; });
    };
    var lefts = edges("x"), tops = edges("y");
    var cells = pieces.map(function(e) {
        return { element: e, row: tops.indexOf(e.rect.y) + 1,
                 column: lefts.indexOf(e.rect.x) + 1 };
    });
    cells.sort(function(a, b) {
        return a.row !== b.row ? a.row - b.row : a.column - b.column;
    });
    return { columns: lefts.length, rows: tops.length, cells: cells };
}

// Bring the table up to date with a newly published model.
function board_overlay_update(published) {
    if (board_overlay === null || published[0].kind !== "board")
        return;
    var width = onscreen_canvas.width / fe_scale;
    var height = onscreen_canvas.height / fe_scale;
    var table = board_overlay.table, rows = board_overlay.row_elements;
    var layout = board_layout(published);
    var squares = layout.cells, by_row = [], i;

    // The squares of each row, in reading order. Each row has at least
    // one, since a row is a top edge of a square.
    for (i = 0; i < layout.rows; i++)
        by_row.push([]);
    for (i = 0; i < squares.length; i++)
        by_row[squares[i].row - 1].push(squares[i]);

    while (rows.length < by_row.length) {
        var row = document.createElement("div");
        row.setAttribute("role", "row");
        table.appendChild(row);
        rows.push(row);
    }
    while (rows.length > by_row.length)
        table.removeChild(rows.pop());

    for (i = 0; i < by_row.length; i++)
        board_overlay_fill_row(rows[i], by_row[i], width, height);

    board_overlay.columns = layout.columns;
    board_overlay.rows = layout.rows;
    board_overlay_name();
    board_overlay_fit();
}

// Bring one row up to date with its squares. The row spans the table's
// width and its squares' height, and each cell sits over its square
// within the row. Each cell holds its square's button, which fills it.
function board_overlay_fill_row(row, squares, width, height) {
    var top = squares[0].element.rect.y, bottom = top, i;
    for (i = 0; i < squares.length; i++) {
        var r = squares[i].element.rect;
        top = Math.min(top, r.y);
        bottom = Math.max(bottom, r.y + r.h);
    }
    var span = bottom - top || 1;
    row.style.top = top / height * 100 + "%";
    row.style.height = span / height * 100 + "%";

    while (row.childNodes.length < squares.length) {
        var cell = document.createElement("div");
        cell.setAttribute("role", "cell");
        var button = document.createElement("button");
        button.type = "button";
        button.setAttribute("tabindex", "-1");
        button.onclick = board_square_click;
        cell.appendChild(button);
        row.appendChild(cell);
    }
    while (row.childNodes.length > squares.length)
        row.removeChild(row.lastChild);

    for (i = 0; i < squares.length; i++) {
        var square = squares[i], rect = square.element.rect;
        var label = board_spoken_label(square.element) +
            ", row " + square.row + ", column " + square.column;
        var c = row.childNodes[i], b = c.firstChild;
        b.board_rect = rect;
        b.board_element = square.element;
        if (b.getAttribute("aria-label") !== label)
            b.setAttribute("aria-label", label);
        c.style.left = rect.x / width * 100 + "%";
        c.style.width = rect.w / width * 100 + "%";
        c.style.top = (rect.y - top) / span * 100 + "%";
        c.style.height = rect.h / span * 100 + "%";
    }
}

// Announcements: what an action changed on the board, said through a
// live region next to the status bar. Each call into C that can change
// the game is begun as a pending action, with the board as it was
// published before it. The action is worded once the board is next
// published at rest, from the boards before and after, and forgotten
// if C did nothing with it. All the wording is here: the puzzle only
// describes its board, and its status text is quoted as it is.
var board_announcer = {
    // The live region, created with the accessible board.
    region: null,
    // The text waiting for the next animation frame to be set, so that
    // the first announcement and a repeated one are both heard.
    queued: null,
    frame: null,
    // The action waiting to be announced: { action, before,
    // was_solved, draws, square }. The page starts by announcing its
    // first board.
    pending: { action: "arrival", before: null, was_solved: false,
               draws: 0 },
    // A pending action still animating when another began. The midend
    // finishes its animation during the new call, and the board it
    // publishes then is this action's.
    superseded: null
};

function board_announce(text) {
    var a = board_announcer;
    if (a.region === null)
        return;
    if (a.frame === null && a.region.ready && a.region.textContent !== text) {
        a.region.textContent = text;
        return;
    }
    // Before the region has been in the page for a frame, or to say the
    // same text again, it's set on the next frame. Clearing it first
    // makes a repeat a change the screen reader hears.
    if (a.frame === null && a.region.ready)
        a.region.textContent = "";
    a.queued = text;
    if (a.frame === null)
        a.frame = window.requestAnimationFrame(board_announce_frame);
}

function board_announce_frame() {
    var a = board_announcer;
    a.frame = null;
    a.region.ready = true;
    if (a.queued !== null)
        a.region.textContent = a.queued;
    a.queued = null;
}

function board_announce_create() {
    var region = document.createElement("div");
    region.id = "announcer";
    region.className = "visually-hidden";
    region.setAttribute("aria-live", "assertive");
    region.setAttribute("aria-atomic", "true");
    region.ready = false;
    if (statusbar !== null)
        statusbar.parentNode.insertBefore(region, statusbar.nextSibling);
    else
        board_overlay.table.parentNode.insertBefore(
            region, board_overlay.hint.nextSibling);
    board_announcer.region = region;
    if (board_announcer.frame === null)
        board_announcer.frame =
            window.requestAnimationFrame(board_announce_frame);
}

// Begin an action ("move", "undo", "redo", "new_game", "restart",
// "solve" or "load") just before calling into C for it. square is the
// square of the accessible board pressed, if any.
function board_announce_begin(action, square) {
    var a = board_announcer;
    if (board_overlay === null)
        return;
    // An action can only still be pending while its move animates.
    a.superseded = a.pending;
    a.pending = { action: action, before: board_elements.published,
                  was_solved: board_elements.status > 0, draws: 0,
                  square: square };
}

// End the call into C. If it had no effect, or drew nothing, the
// action is forgotten, and one it superseded is still pending. A
// restart from the start draws nothing but is still announced.
function board_announce_end(effect, no_effect) {
    var a = board_announcer, p = a.pending;
    if (board_overlay === null || p === null)
        return;
    if (effect && p.draws === 0 && p.action === "restart") {
        a.pending = null;
        board_announce_word(p, board_elements.published,
                            board_elements.status);
    } else if (!effect || p.draws === 0) {
        a.pending = a.superseded;
        if (no_effect && p.square)
            board_announce(p.square.kind === "space" ? "Nothing to move" :
                           board_spoken_label(p.square) + " can't move");
    } else if (a.superseded !== null) {
        // Its animation wasn't finished, so this action takes it over.
        p.before = a.superseded.before;
        p.was_solved = a.superseded.was_solved;
    }
    a.superseded = null;
}

// Called for every redraw, and with the model after each publish.
function board_announce_drawn() {
    if (board_announcer.pending !== null)
        board_announcer.pending.draws++;
}

function board_announce_published(published, status) {
    var a = board_announcer, p = a.superseded;
    if (p !== null) {
        // The superseded action's animation finished: its board is this
        // one, and the new action starts from it.
        a.superseded = null;
        board_announce_word(p, published, status);
        a.pending.before = published;
        a.pending.was_solved = status > 0;
        a.pending.draws = 0;
        return;
    }
    p = a.pending;
    if (p === null)
        return;
    a.pending = null;
    board_announce_word(p, published, status);
}

function board_announce_word(p, after, status) {
    var redid = p.action === "redo" ? board_history_current() : null;
    var text = board_announcement(p.action, redid, board_elements.puzzle.name,
                                  statusbar !== null ? statusbar.textContent : "",
                                  p.before || [], after,
                                  status > 0 && !p.was_solved);
    if (text !== null)
        board_announce(text);
}

// The action a key on the canvas runs in the midend rather than the
// puzzle, mirroring the key mapping in key() in emcc.c and
// midend_process_key(), which turns Ctrl+letter into a control
// character and ignores Shift. (A puzzle that uses one of these keys
// itself takes it first; Fifteen uses none.) Any other key is a move.
function board_key_action(event) {
    var key = event.key, ctrl = event.ctrlKey, c;
    var puzzle = board_elements.puzzle;
    if (ctrl && event.shiftKey && (key === "Z" || key === "z"))
        return "redo";
    if (key && key.length === 1 && key.charCodeAt(0) < 0x80)
        c = key.charCodeAt(0);
    else if (!key && event.char && event.char.length === 1)
        c = event.char.charCodeAt(0) & 0xFF;
    else
        return "move";
    if (ctrl) {
        if (c < 0x40 || c >= 0x80)
            return "move";
        c &= 0x1F;
    }
    var letter = function(l) {
        return puzzle.one_key_shortcuts &&
            (c === l.charCodeAt(0) || c === l.toUpperCase().charCodeAt(0));
    };
    if (letter("n") || c === 0x0E)
        return "new_game";
    if (letter("u") || c === 0x2A || c === 0x1A || c === 0x1F)
        return "undo";
    if (letter("r") || c === 0x23 || c === 0x12 || c === 0x19)
        return "redo";
    if (puzzle.can_solve && c === 0x13)
        return "solve";
    return "move";
}

// Whether the mouse press just sent was understood but had no effect.
function board_press_had_no_effect() {
    var result = board_elements.press_result;
    return result !== null && result.no_effect;
}

// Called from initPuzzle with a function returning the saved game, as
// the Save button gives it.
var board_save_file = null;

// What the last move done or redone was ("move", "solve" or
// "restart"), from the undo history in the saved game: its MOVE, SOLVE
// and RESTART records, and STATEPOS, 1 at the start of the history.
function board_history_current() {
    var text = board_save_file !== null ? board_save_file() : "";
    var entries = [], position = null, i = 0;
    var read = function(terminator) {
        var end = text.indexOf(terminator, i);
        if (end < 0)
            return null;
        var s = text.substring(i, end);
        i = end + 1;
        return s;
    };
    while (i < text.length) {
        var key = read(":"), length = key === null ? null : read(":");
        if (length === null || !/^[0-9]+$/.test(length))
            return null;
        // The length counts bytes, and these records' values are ASCII;
        // any others are skipped by their encoded length.
        var start = i, bytes = parseInt(length, 10);
        while (bytes > 0 && i < text.length) {
            var code = text.charCodeAt(i++);
            bytes -= code < 0x80 ? 1 : code < 0x800 ? 2 :
                code >= 0xD800 && code < 0xDC00 ? (i++, 4) : 3;
        }
        var value = text.substring(start, i);
        i++;
        key = key.trim();
        if (key === "STATEPOS")
            position = parseInt(value, 10);
        else if (key === "MOVE")
            entries.push("move");
        else if (key === "SOLVE")
            entries.push("solve");
        else if (key === "RESTART")
            entries.push("restart");
    }
    return position !== null && position >= 2 ?
        entries[position - 2] : null;
}

// The whole announcement for an action, from the boards before and
// after it, or null if there's nothing to say. A move, undo or redo
// says only what moved, adding "Solved." and the status text if the
// game became solved. Any other action, and the redo of a solve or a
// restart, says the action, the board's name, its layout and the
// status text.
function board_announcement(action, redid, puzzle, status, before, after,
                            became_solved) {
    var moved = board_moves(before, after);
    var solved = became_solved ? board_joined(["Solved.", status]) : null;
    var described = function(action) {
        var layout = board_layout(after);
        var wording = action === "new_game" ? "New game." :
            action === "restart" ? "Restarted." :
            action === "solve" ? "Solved by computer." : puzzle + ".";
        var name = layout.cells.length === 0 ? puzzle + " board" :
            puzzle + " board, " + layout.columns + " by " + layout.rows;
        return board_joined([wording, name + ".", board_layout_text(layout),
                             status]);
    };
    switch (action) {
      case "move":
        return moved === null ? null : board_joined([moved, solved]);
      case "undo":
        return board_joined(["Undo.", moved, solved]);
      case "redo":
        if (redid === "solve" || redid === "restart")
            return board_joined(["Redo.", described(redid)]);
        return board_joined(["Redo.", moved, solved]);
      default:
        return described(action);
    }
}

// The non-empty parts, as one announcement.
function board_joined(parts) {
    return parts.filter(function(part) {
        return part !== null && part !== "";
    }).join(" ");
}

// "Row 1: 1, 2, 3, 4. Row 2: ...", each square by its label and the
// space as "Empty", in reading order. Null for an empty layout.
function board_layout_text(layout) {
    var rows = [], i;
    for (i = 0; i < layout.cells.length; i++) {
        var cell = layout.cells[i];
        if (rows.length === 0 || rows[rows.length - 1].row !== cell.row)
            rows.push({ row: cell.row, labels: [] });
        rows[rows.length - 1].labels.push(board_spoken_label(cell.element));
    }
    if (rows.length === 0)
        return null;
    return rows.map(function(row) {
        return "Row " + row.row + ": " + row.labels.join(", ") + ".";
    }).join(" ");
}

// "5", "5 and 6", "5, 6 and 7".
function board_list(names) {
    if (names.length < 2)
        return names.length ? names[0] : "";
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

// The tiles that moved between two published models, and which way:
// "7 moved left.", "5, 6 and 7 moved left.", "5 and 6 moved." or
// "14 tiles moved.". Null if no tile moved.
function board_moves(before, after) {
    var old = {}, moved = [], i;
    var key = function(e) { return e.kind + " " + e.id; };
    for (i = 0; i < before.length; i++)
        if (before[i].kind === "tile" && !(key(before[i]) in old))
            old[key(before[i])] = before[i].rect;
    // after is in reading order.
    for (i = 0; i < after.length; i++) {
        var e = after[i], from = old[key(after[i])];
        if (e.kind === "tile" && from &&
            (from.x !== e.rect.x || from.y !== e.rect.y))
            moved.push({ element: e, from: from });
    }
    if (moved.length === 0)
        return null;
    if (moved.length >= 4)
        return moved.length + " tiles moved.";

    var direction = function(m) {
        var dx = m.element.rect.x - m.from.x, dy = m.element.rect.y - m.from.y;
        return dy === 0 ? (dx < 0 ? "left" : "right") :
            dx === 0 ? (dy < 0 ? "up" : "down") : null;
    };
    var way = direction(moved[0]), names;
    var horizontal = way === "left" || way === "right";
    var line = moved.every(function(m) {
        return direction(m) === way && (horizontal ? m.from.y === moved[0].from.y :
                                         m.from.x === moved[0].from.x);
    });
    if (way === null || !line) {
        names = moved.map(function(m) { return board_spoken_label(m.element); });
        return board_list(names) + " moved.";
    }
    // The leading tile first.
    var lead = { left: function(r) { return r.x; },
                 right: function(r) { return -r.x; },
                 up: function(r) { return r.y; },
                 down: function(r) { return -r.y; } }[way];
    names = moved.slice().sort(function(a, b) {
        return lead(a.element.rect) - lead(b.element.rect);
    }).map(function(m) { return board_spoken_label(m.element); });
    return board_list(names) + " moved " + way + ".";
}

// Set the font on a CanvasRenderingContext2d based on the CSS font
// for the canvas, the requested size, and whether we want something
// monospaced.
function canvas_set_font(ctx, size, monospaced) {
    var s = window.getComputedStyle(onscreen_canvas);
    // First set something that we're certain will work.  Constructing
    // the font string from the computed style is a bit fragile, so
    // this acts as a fallback.
    ctx.font = `${size}px ` + (monospaced ? "monospace" : "sans-serif");
    // In CSS Fonts Module Level 4, "font-stretch" gets serialised as
    // a percentage, which can't be used in
    // CanvasRenderingContext2d.font, so we omit it.
    ctx.font = `${s.fontStyle} ${s.fontWeight} ${size}px ` +
        (monospaced ? "monospace" : s.fontFamily);
}

// Enable and disable items in the CSS menus.
function disable_menu_item(item, disabledFlag) {
    item.disabled = disabledFlag;
}

// Dialog-box functions called from both C and JS.
function dialog_init(titletext) {
    // Forward compatibility: Delete form and dimmer if they already
    // exist.
    dlg_dimmer = document.getElementById("dlgdimmer");
    if (dlg_dimmer) dlg_dimmer.parentElement.removeChild(dlg_dimmer);
    dlg_form = document.getElementById("dlgform");
    if (dlg_form) dlg_form.parentElement.removeChild(dlg_form);

    // Create an overlay on the page which darkens everything
    // beneath it.
    dlg_dimmer = document.createElement("div");
    dlg_dimmer.id = "dlgdimmer";

    // Now create a form which sits on top of that in turn.
    dlg_form = document.createElement("form");
    dlg_form.id = "dlgform";

    var title = document.createElement("h2");
    title.appendChild(document.createTextNode(titletext));
    dlg_form.appendChild(title);

    dlg_return_funcs = [];
}

function dialog_launch(ok_function, cancel_function) {
    // Put in the OK and Cancel buttons at the bottom.
    var button;

    if (ok_function) {
        button = document.createElement("input");
        button.type = "button";
        button.value = "OK";
        button.onclick = ok_function;
        dlg_form.appendChild(button);
    }

    if (cancel_function) {
        button = document.createElement("input");
        button.type = "button";
        button.value = "Cancel";
        button.onclick = cancel_function;
        dlg_form.appendChild(button);
    }

    document.body.appendChild(dlg_dimmer);
    document.body.appendChild(dlg_form);
    dlg_form.querySelector("input,select,a").focus();
}

function dialog_cleanup() {
    document.body.removeChild(dlg_dimmer);
    document.body.removeChild(dlg_form);
    dlg_dimmer = dlg_form = null;
    onscreen_canvas.focus();
}

function set_capture(element, event) {
    // This is only needed if we don't have Pointer Events available.
    if (element.setCapture !== undefined &&
        element.setPointerCapture === undefined) {
        element.setCapture(true);
        return;
    }
}

// Init function called early in main().
function initPuzzle() {
    // Construct the off-screen canvas used for double buffering.
    onscreen_canvas = document.getElementById("puzzlecanvas");
    offscreen_canvas = document.createElement("canvas");
    ctx = offscreen_canvas.getContext('2d', { alpha: false });

    // Stop right-clicks on the puzzle from popping up a context menu.
    // We need those right-clicks!
    onscreen_canvas.oncontextmenu = function(event) { return false; }

    // Set up mouse handlers. We do a bit of tracking of the currently
    // pressed mouse buttons, to avoid sending mousemoves with no
    // button down (our puzzles don't want those events).
    var mousedown = Module.cwrap('mousedown', 'boolean',
                                 ['number', 'number', 'number']);

    var button_phys2log = [null, null, null];
    var buttons_down = function() {
        var i, toret = 0;
        for (i = 0; i < 3; i++)
            if (button_phys2log[i] !== null)
                toret |= 1 << button_phys2log[i];
        return toret;
    };

    onscreen_canvas.onpointerdown = function(event) {
        // Arrange that all mouse (and pointer) events are sent to
        // this element until all buttons are released.  We can assume
        // that if we managed to receive a pointerdown event,
        // Element.setPointerCapture() is available.
        onscreen_canvas.setPointerCapture(event.pointerId);
    }
    onscreen_canvas.onmousedown = function(event) {
        if (event.button >= 3)
            return;

        var xy = canvas_mouse_coords(event, onscreen_canvas);
        var logbutton = event.button;
        if (event.shiftKey)
            logbutton = 1;   // Shift-click overrides to middle button
        else if (event.ctrlKey)
            logbutton = 2;   // Ctrl-click overrides to right button

        board_announce_begin("move");
        board_elements.press_result = null;
        var used = mousedown(xy.x, xy.y, logbutton);
        board_announce_end(used && !board_press_had_no_effect());
        if (used)
            event.preventDefault();
        button_phys2log[event.button] = logbutton;

        set_capture(onscreen_canvas, event);
    };
    var mousemove = Module.cwrap('mousemove', 'boolean',
                                 ['number', 'number', 'number']);
    onscreen_canvas.onmousemove = function(event) {
        var down = buttons_down();
        if (down) {
            var xy = canvas_mouse_coords(event, onscreen_canvas);
            if (mousemove(xy.x, xy.y, down))
                event.preventDefault();
        }
    };
    var mouseup = Module.cwrap('mouseup', 'boolean',
                               ['number', 'number', 'number']);
    onscreen_canvas.onmouseup = function(event) {
        if (event.button >= 3)
            return;

        if (button_phys2log[event.button] !== null) {
            var xy = canvas_mouse_coords(event, onscreen_canvas);
            if (mouseup(xy.x, xy.y, button_phys2log[event.button]))
                event.preventDefault();
            button_phys2log[event.button] = null;
        }
    };

    // A press on a square of the accessible board is a left click at
    // its centre, through the same entry points as the mouse. If it has
    // no effect, that's announced.
    board_square_press = function(x, y, square) {
        board_announce_begin("move", square);
        board_elements.press_result = null;
        var used = mousedown(x, y, 0);
        var no_effect = board_press_had_no_effect();
        board_announce_end(used && !no_effect, no_effect);
        mouseup(x, y, 0);
    };

    // Set up keyboard handlers. We call event.preventDefault()
    // in the keydown handler if it looks like we might have
    // done something with the key.  This means that users
    // of this puzzle collection in other media
    // can indulge their instinct to press ^R for redo, for example,
    // without accidentally reloading the page.
    var key = Module.cwrap('key', 'boolean', ['number', 'string', 'string',
                                              'number', 'number', 'number']);
    onscreen_canvas.onkeydown = function(event) {
        if (board_overlay !== null)
            board_announce_begin(board_key_action(event));
        var used = key(event.keyCode, event.key, event.char, event.location,
                       event.shiftKey ? 1 : 0, event.ctrlKey ? 1 : 0);
        board_announce_end(used);
        if (used)
            event.preventDefault();
    };

    // command() is a C function called to pass back events which
    // don't fall into other categories like mouse and key events.
    // Mostly those are button presses, but there's also one for the
    // game-type dropdown having been changed.
    command = Module.cwrap('command', 'void', ['number']);
    // The game commands, announced as the same keys are.
    var game_command = function(n, action) {
        board_announce_begin(action);
        command(n);
        board_announce_end(true);
    };

    // Event handlers for buttons and things, which call command().
    if (specific_button) specific_button.onclick = function(event) {
        // Ensure we don't accidentally process these events when a
        // dialog is actually active, e.g. because the button still
        // has keyboard focus
        if (dlg_dimmer === null)
            command(0);
    };
    if (random_button) random_button.onclick = function(event) {
        if (dlg_dimmer === null)
            command(1);
    };
    if (new_button) new_button.onclick = function(event) {
        if (dlg_dimmer === null)
            game_command(5, "new_game");
    };
    if (restart_button) restart_button.onclick = function(event) {
        if (dlg_dimmer === null)
            game_command(6, "restart");
    };
    if (undo_button) undo_button.onclick = function(event) {
        if (dlg_dimmer === null)
            game_command(7, "undo");
    };
    if (redo_button) redo_button.onclick = function(event) {
        if (dlg_dimmer === null)
            game_command(8, "redo");
    };
    if (solve_button) solve_button.onclick = function(event) {
        if (dlg_dimmer === null)
            game_command(9, "solve");
    };
    if (prefs_button) prefs_button.onclick = function(event) {
        if (dlg_dimmer === null)
            command(10);
    };

    // 'number' is used for C pointers
    var get_save_file = Module.cwrap('get_save_file', 'number', []);
    var free_save_file = Module.cwrap('free_save_file', 'void', ['number']);
    var load_game = Module.cwrap('load_game', 'void', []);
    board_save_file = function() {
        var savefile_ptr = get_save_file();
        var savefile_text = UTF8ToString(savefile_ptr);
        free_save_file(savefile_ptr);
        return savefile_text;
    };

    if (save_button) save_button.onclick = function(event) {
        if (dlg_dimmer === null) {
            var savefile_ptr = get_save_file();
            var savefile_text = UTF8ToString(savefile_ptr);
            free_save_file(savefile_ptr);
            dialog_init("Download saved-game file");
            dlg_form.appendChild(document.createTextNode(
                "Click to download the "));
            var a = document.createElement("a");
            a.download = "puzzle.sav";
            a.href = "data:application/octet-stream," +
                encodeURIComponent(savefile_text);
            a.appendChild(document.createTextNode("saved-game file"));
            dlg_form.appendChild(a);
            dlg_form.appendChild(document.createTextNode("."));
            dlg_form.appendChild(document.createElement("br"));
            dialog_launch(function(event) {
                dialog_cleanup();
            });
        }
    };

    if (load_button) load_button.onclick = function(event) {
        if (dlg_dimmer === null) {
            var input = document.createElement("input");
            input.type = "file";
            input.multiple = false;
            input.addEventListener("change", function(event) {
                if (input.files.length == 1) {
                    var file = input.files.item(0);
                    var reader = new FileReader();
                    reader.addEventListener("load", function() {
                        var pos = 0;
                        savefile_read_callback = function(buf, len) {
                            if (pos + len > reader.result.byteLength)
                                return false;
                            writeArrayToMemory(
                                new Int8Array(reader.result, pos, len), buf);
                            pos += len;
                            return true;
                        }
                        board_announce_begin("load");
                        load_game();
                        board_announce_end(true);
                        savefile_read_callback = null;
                    });
                    reader.addEventListener("error", function() {
                        alert("An error occured while loading the file");
                    });
                    reader.readAsArrayBuffer(file);
                }
            });
            input.click();
            onscreen_canvas.focus();
        }
    };

    // Find the next or previous item in a menu, or null if there
    // isn't one.  Skip list items that don't have a child (i.e.
    // separators) or whose child is disabled.
    function isuseful(item) {
        return item.querySelector(":scope > :not(:disabled)");
    }
    function nextmenuitem(item) {
        do item = item.nextElementSibling;
        while (item !== null && !isuseful(item));
        return item;
    }
    function prevmenuitem(item) {
        do item = item.previousElementSibling;
        while (item !== null && !isuseful(item));
        return item;
    }
    function firstmenuitem(menu) {
        var item = menu && menu.firstElementChild;
        while (item !== null && !isuseful(item))
            item = item.nextElementSibling;
        return item;
    }
    function lastmenuitem(menu) {
        var item = menu && menu.lastElementChild;
        while (item !== null && !isuseful(item))
            item = item.previousElementSibling;
        return item;
    }
    // Keyboard handlers for the menus.
    function menukey(event) {
        var target = event.target;
        var key = event.key;
        var thisitem = target.closest("li");
        var thismenu = thisitem.closest("ul");
        var targetitem = null;
        var parentitem;
        var parentitem_up = null;
        var parentitem_sideways = null;
        var submenu;
        function ishorizontal(menu) {
            // Which direction does this menu go in?
            var cs = window.getComputedStyle(menu);
            return cs.display == "flex" && cs.flexDirection == "row";
        }
        if (dlg_dimmer !== null)
            return;
        if (["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
            .includes(key)) {
            var shortcutitem = thismenu.querySelectorAll(
                ":scope > li:not([role='separator']")[(Number(key) + 9) % 10];
            if (shortcutitem) {
                target = shortcutitem.firstElementChild;
                target.focus();
                thisitem = target.closest("li");
                key = "Enter";
            }
        }
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter",
              "Escape", "Backspace", "SoftRight", "F10"]
            .includes(key))
            return;
        if (ishorizontal(thismenu)) {
            // Top-level menu bar.
            if (key == "ArrowLeft")
                targetitem = prevmenuitem(thisitem) || lastmenuitem(thismenu);
            else if (key == "ArrowRight")
                targetitem = nextmenuitem(thisitem) || firstmenuitem(thismenu);
            else if (key == "ArrowUp")
                targetitem = lastmenuitem(thisitem.querySelector("ul"));
            else if (key == "ArrowDown" || key == "Enter")
                targetitem = firstmenuitem(thisitem.querySelector("ul"));
        } else {
            // Ordinary vertical menu.
            parentitem = thismenu.closest("li");
            if (parentitem) {
                if (ishorizontal(parentitem.closest("ul")))
                    parentitem_up = parentitem;
                else
                    parentitem_sideways = parentitem;
            }
            if (key == "ArrowUp")
                targetitem = prevmenuitem(thisitem) || parentitem_up ||
                    lastmenuitem(thismenu);
            else if (key == "ArrowDown")
                targetitem = nextmenuitem(thisitem) || parentitem_up ||
                    firstmenuitem(thismenu);
            else if (key == "ArrowRight")
                targetitem = thisitem.querySelector("li") ||
                    (parentitem_up && nextmenuitem(parentitem_up));
            else if (key == "Enter")
                targetitem = thisitem.querySelector("li");
            else if (key == "ArrowLeft")
                targetitem = parentitem_sideways ||
                    (parentitem_up && prevmenuitem(parentitem_up));
            else if (key == "Backspace")
                targetitem = parentitem;
        }
        if (targetitem)
            targetitem.firstElementChild.focus();
        else if (key == "Enter")
            target.click();
        else if (key == "Escape" || key == "SoftRight" ||
                 key == "F10" || key == "Backspace")
            // Leave the menu entirely.
            onscreen_canvas.focus();
        // Prevent default even if we didn't do anything, as long as this
        // was an interesting key.
        event.preventDefault();
        event.stopPropagation();
    }
    menuform.addEventListener("keydown", menukey);

    // Open documentation links within the application in KaiOS.
    for (var elem of document.querySelectorAll("#gamemenu a[href]")) {
        elem.addEventListener("click", function(event) {
            window.open(event.target.href);
            event.preventDefault();
        });
    }

    // In IE, the canvas doesn't automatically gain focus on a mouse
    // click, so make sure it does
    onscreen_canvas.addEventListener("mousedown", function(event) {
        onscreen_canvas.focus();
    });

    // In our dialog boxes, Return and Escape should be like pressing
    // OK and Cancel respectively
    document.addEventListener("keydown", function(event) {

        if (dlg_dimmer !== null && event.keyCode == 13) {
            for (var i in dlg_return_funcs)
                dlg_return_funcs[i]();
            command(3);
            event.preventDefault();
            event.stopPropagation();
        }

        if (dlg_dimmer !== null && event.keyCode == 27) {
            command(4);
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    // Arrange that the softkey labels are clickable.  This logically
    // belongs as a click handler, but by the time the click event
    // fires, the input focus is in the wrong place.
    function button_to_key(key) {
        return function(mevent) {
            mevent.stopPropagation();
            mevent.preventDefault();
            var kevent = new KeyboardEvent("keydown", {
                key: key, view: window, bubbles: true});
            document.activeElement.dispatchEvent(kevent);
        };
    }
    for (var elem of document.querySelectorAll(".lsk"))
        elem.addEventListener("mousedown", button_to_key("SoftLeft"));
    for (var elem of document.querySelectorAll(".csk"))
        elem.addEventListener("mousedown", button_to_key("Enter"));
    for (var elem of document.querySelectorAll(".rsk"))
        elem.addEventListener("mousedown", button_to_key("SoftRight"));

    document.addEventListener("keydown", function(event) {
        // Key to open the menu on KaiOS.
        if ((event.key == "SoftRight" || event.key == "F10") &&
            !menuform.contains(document.activeElement)) {
            menuform.querySelector("li div, li button").focus();
            event.preventDefault();
            event.stopPropagation();
        }
    });

    // Handle "copy" actions.  Browsers don't reliably target the
    // "copy" event at the canvas when it's focused.  Firefox 102
    // targets the containing <div> while Chromium 114 targets the
    // <body>.  So we catch the event at the document level and work
    // out if it's relevant ourselves.
    var get_text_format = Module.cwrap('get_text_format', 'number', []);
    var free_text_format = Module.cwrap('free_text_format', 'void', ['number']);
    document.addEventListener("copy", function(event) {
        // Make sure the target is an ancestor of the canvas.  And if
        // there's a selection assume the user wants to copy that and
        // not the puzzle.
        if (event.target.contains(onscreen_canvas) &&
            window.getSelection().isCollapsed) {
            var ptr = get_text_format();
            event.clipboardData.setData('text/plain', UTF8ToString(ptr));
            event.preventDefault();
            free_text_format(ptr);
        }
    });

    // Event handler to fake :focus-within on browsers too old for
    // it (like KaiOS 2.5).  Browsers without :focus-within are also
    // too old for focusin/out events, so we have to use focus events
    // which don't bubble but can be captured.
    //
    // A button losing focus because it was disabled doesn't generate
    // a blur event, so we do this entirely in the focus handler.
    document.documentElement.addEventListener("focus", function(event) {
        for (var elem = event.target; elem; elem = elem.parentElement)
            elem.classList.add("focus-within");
        for (elem of
             Array.from(document.getElementsByClassName("focus-within")))
            if (!elem.contains(event.target))
                elem.classList.remove("focus-within");
    }, true);

    // Set up the function pointers we haven't already grabbed. 
    dlg_return_sval = Module.cwrap('dlg_return_sval', 'void',
                                   ['number','string']);
    dlg_return_ival = Module.cwrap('dlg_return_ival', 'void',
                                   ['number','number']);
    timer_callback = Module.cwrap('timer_callback', 'void', ['number']);
    prefs_load_callback = Module.cwrap('prefs_load_callback', 'void',
                                       ['number','number']);

    if (resizable_div !== null) {
        var resize_handle = document.getElementById("resizehandle");
        var resize_xbase = null, resize_ybase = null, restore_pending = false;
        var resize_xoffset = null, resize_yoffset = null;
        var resize_puzzle = Module.cwrap('resize_puzzle',
                                         'void', ['number', 'number']);
        var restore_puzzle_size = Module.cwrap('restore_puzzle_size',
                                               'void', []);
        resize_handle.oncontextmenu = function(event) { return false; }
        resize_handle.onpointerdown = function(event) {
            resize_handle.setPointerCapture(event.pointerId);
        }
        resize_handle.onmousedown = function(event) {
            if (event.button == 0) {
                var xy = element_coords(onscreen_canvas);
                resize_xbase = xy.x + onscreen_canvas.offsetWidth / 2;
                resize_ybase = xy.y;
                resize_xoffset =
                    xy.x + onscreen_canvas.offsetWidth - event.pageX;
                resize_yoffset =
                    xy.y + onscreen_canvas.offsetHeight - event.pageY;
            } else {
                restore_pending = true;
            }
            set_capture(resize_handle, event);
            event.preventDefault();
        };
        window.addEventListener("mousemove", function(event) {
            if (resize_xbase !== null && resize_ybase !== null) {
                var dpr = window.devicePixelRatio || 1;
                resize_puzzle(
                    (event.pageX + resize_xoffset - resize_xbase) * dpr * 2,
                    (event.pageY + resize_yoffset - resize_ybase) * dpr);
                event.preventDefault();
                // Chrome insists on selecting text during a resize drag
                // no matter what I do
                if (window.getSelection)
                    window.getSelection().removeAllRanges();
                else
                    document.selection.empty();        }
        });
        window.addEventListener("mouseup", function(event) {
            if (resize_xbase !== null && resize_ybase !== null) {
                resize_xbase = null;
                resize_ybase = null;
                onscreen_canvas.focus(); // return focus to the puzzle
                event.preventDefault();
            } else if (restore_pending) {
                // If you have the puzzle at larger than normal size and
                // then right-click to restore, I haven't found any way to
                // stop Chrome and IE popping up a context menu on the
                // revealed piece of document when you release the button
                // except by putting the actual restore into a setTimeout.
                // Gah.
                setTimeout(function() {
                    restore_pending = false;
                    restore_puzzle_size();
                    onscreen_canvas.focus();
                }, 20);
                event.preventDefault();
            }
        });
    }

    var rescale_puzzle = Module.cwrap('rescale_puzzle', 'void', []);
    /*
     * If the puzzle is sized to fit the page, try to detect changes
     * of size of the containing element.  Ideally this would use a
     * ResizeObserver on the containing_div, but I want this to work
     * on KaiOS 2.5, which doesn't have ResizeObserver.  Instead we
     * watch events that might indicate that the div has changed size.
     */
    if (containing_div !== null) {
        var resize_handler = function(event) {
            rescale_puzzle();
        }
        window.addEventListener("resize", resize_handler);
        // Also catch the point when the document finishes loading,
        // since sometimes we seem to get the div's size too early.
        window.addEventListener("load", resize_handler);
    }

}

function post_init() {
    /*
     * Arrange to detect changes of device pixel ratio.  Adapted from
     * <https://developer.mozilla.org/en-US/docs/Web/API/Window/
     * devicePixelRatio> (CC0) to work on older browsers.
     */
    var rescale_puzzle = Module.cwrap('rescale_puzzle', 'void', []);
    var mql = null;
    var update_pixel_ratio = function() {
        var dpr = window.devicePixelRatio;
        if (mql !== null)
            mql.removeListener(update_pixel_ratio);
        mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
        mql.addListener(update_pixel_ratio);
        rescale_puzzle();
    }

    update_pixel_ratio();
    // If we get here with everything having gone smoothly, i.e.
    // we haven't crashed for one reason or another during setup, then
    // it's probably safe to hide the 'sorry, no puzzle here' div and
    // show the div containing the actual puzzle.
    var apology = document.getElementById("apology");
    if (apology !== null) apology.style.display = "none";
    document.getElementById("puzzle").style.display = "";
    board_overlay_fit();

    // Default to giving keyboard focus to the puzzle.
    onscreen_canvas.focus();
}
