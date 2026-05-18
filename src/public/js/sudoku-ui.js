const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const DIFFICULTY_REMOVALS = {
    easy: 40,
    medium: 48,
    hard: 54
};

function createSeedGrid() {
    return Array.from({ length: 9 }, (_, row) =>
        Array.from({ length: 9 }, (_, col) => ((row * 3 + Math.floor(row / 3) + col) % 9) + 1)
    );
}

function randomInt(max) {
    return Math.floor(Math.random() * max);
}

function shuffle(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function cloneGrid(grid) {
    return grid.map((row) => row.slice());
}

function gridToKey(grid) {
    return grid.flat().join("");
}

function getBoxStart(index) {
    return Math.floor(index / 3) * 3;
}

function isPlacementValid(grid, row, col, value) {
    for (let i = 0; i < 9; i += 1) {
        if (grid[row][i] === value && i !== col) return false;
        if (grid[i][col] === value && i !== row) return false;
    }

    const rowStart = getBoxStart(row);
    const colStart = getBoxStart(col);
    for (let r = rowStart; r < rowStart + 3; r += 1) {
        for (let c = colStart; c < colStart + 3; c += 1) {
            if ((r !== row || c !== col) && grid[r][c] === value) return false;
        }
    }

    return true;
}

function findNextEmpty(grid) {
    for (let row = 0; row < 9; row += 1) {
        for (let col = 0; col < 9; col += 1) {
            if (grid[row][col] === 0) {
                return [row, col];
            }
        }
    }
    return null;
}

function countSolutions(grid, limit = 2) {
    const cell = findNextEmpty(grid);
    if (!cell) {
        return 1;
    }

    const [row, col] = cell;
    let count = 0;

    for (const value of DIGITS) {
        if (!isPlacementValid(grid, row, col, value)) {
            continue;
        }
        grid[row][col] = value;
        count += countSolutions(grid, limit);
        if (count >= limit) {
            grid[row][col] = 0;
            return count;
        }
        grid[row][col] = 0;
    }

    return count;
}

function buildSolvedGrid() {
    let grid = createSeedGrid();
    const digitMap = shuffle(DIGITS);

    grid = grid.map((row) => row.map((value) => digitMap[value - 1]));

    const rowBands = shuffle([0, 1, 2]);
    const colBands = shuffle([0, 1, 2]);
    const rowOrder = rowBands.flatMap((band) => shuffle([0, 1, 2]).map((offset) => band * 3 + offset));
    const colOrder = colBands.flatMap((band) => shuffle([0, 1, 2]).map((offset) => band * 3 + offset));

    return rowOrder.map((rowIndex) => colOrder.map((colIndex) => grid[rowIndex][colIndex]));
}

function createPuzzle(solution, difficulty) {
    const puzzle = cloneGrid(solution);
    const targetRemovals = DIFFICULTY_REMOVALS[difficulty] || DIFFICULTY_REMOVALS.medium;
    const positions = shuffle(Array.from({ length: 81 }, (_, index) => index));
    let removed = 0;

    for (const position of positions) {
        if (removed >= targetRemovals) {
            break;
        }

        const row = Math.floor(position / 9);
        const col = position % 9;
        const previous = puzzle[row][col];
        puzzle[row][col] = 0;

        const probe = cloneGrid(puzzle);
        if (countSolutions(probe, 2) !== 1) {
            puzzle[row][col] = previous;
            continue;
        }

        removed += 1;
    }

    return puzzle;
}

function generateSudoku(difficulty) {
    const solution = buildSolvedGrid();
    const puzzle = createPuzzle(solution, difficulty);
    return { puzzle, solution };
}

function createNoteSetGrid() {
    return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => new Set()));
}

function sameGroup(aRow, aCol, bRow, bCol) {
    return (
        aRow === bRow ||
        aCol === bCol ||
        (getBoxStart(aRow) === getBoxStart(bRow) && getBoxStart(aCol) === getBoxStart(bCol))
    );
}

class SudokuUI {
    constructor(root) {
        this.root = root;
        this.boardElement = root.querySelector("#sudoku-board");
        this.padElement = root.querySelector("#sudoku-pad");
        this.statusElement = root.querySelector("#sudoku-status");
        this.difficultySelect = root.querySelector("#sudoku-difficulty");
        this.notesButton = root.querySelector("#sudoku-notes");
        this.newButton = root.querySelector("#sudoku-new");
        this.resetButton = root.querySelector("#sudoku-reset");
        this.checkButton = root.querySelector("#sudoku-check");
        this.solveButton = root.querySelector("#sudoku-solve");
        this.clearButton = root.querySelector("#sudoku-clear");

        this.labels = {
            statusReady: root.dataset.statusReady,
            statusSolved: root.dataset.statusSolved,
            statusInvalid: root.dataset.statusInvalid,
            statusIncomplete: root.dataset.statusIncomplete,
            statusReset: root.dataset.statusReset,
            statusSolvedReveal: root.dataset.statusSolvedReveal
        };

        this.selected = { row: 0, col: 0 };
        this.notesMode = false;
        this.boardButtons = [];

        this.startNewGame();
        this.bindEvents();
    }

    startNewGame() {
        const difficulty = this.difficultySelect?.value || "medium";
        const { puzzle, solution } = generateSudoku(difficulty);

        this.puzzle = puzzle;
        this.solution = solution;
        this.current = cloneGrid(puzzle);
        this.notes = createNoteSetGrid();
        this.selected = this.findFirstEditableCell() || { row: 0, col: 0 };
        this.notesMode = false;
        this.notesButton?.setAttribute("aria-pressed", "false");
        this.render();
        this.setStatus(this.labels.statusReady);
    }

    resetGame() {
        this.current = cloneGrid(this.puzzle);
        this.notes = createNoteSetGrid();
        this.selected = this.findFirstEditableCell() || { row: 0, col: 0 };
        this.render();
        this.setStatus(this.labels.statusReset);
    }

    revealSolution() {
        this.current = cloneGrid(this.solution);
        this.notes = createNoteSetGrid();
        this.render();
        this.setStatus(this.labels.statusSolvedReveal);
    }

    findFirstEditableCell() {
        for (let row = 0; row < 9; row += 1) {
            for (let col = 0; col < 9; col += 1) {
                if (this.puzzle[row][col] === 0) {
                    return { row, col };
                }
            }
        }
        return null;
    }

    bindEvents() {
        this.newButton?.addEventListener("click", () => this.startNewGame());
        this.resetButton?.addEventListener("click", () => this.resetGame());
        this.solveButton?.addEventListener("click", () => this.revealSolution());
        this.checkButton?.addEventListener("click", () => this.checkBoard());
        this.clearButton?.addEventListener("click", () => this.clearSelectedCell());
        this.notesButton?.addEventListener("click", () => this.toggleNotesMode());
        this.difficultySelect?.addEventListener("change", () => this.startNewGame());

        document.addEventListener("keydown", (event) => {
            if (!this.root.contains(document.activeElement) && document.activeElement !== document.body) {
                return;
            }

            const { key } = event;
            if (/^[1-9]$/.test(key)) {
                event.preventDefault();
                this.applyDigit(Number(key));
                return;
            }

            if (key === "Backspace" || key === "Delete" || key === "0") {
                event.preventDefault();
                this.clearSelectedCell();
                return;
            }

            if (key.toLowerCase() === "n") {
                event.preventDefault();
                this.toggleNotesMode();
                return;
            }

            const movement = {
                ArrowUp: [-1, 0],
                ArrowDown: [1, 0],
                ArrowLeft: [0, -1],
                ArrowRight: [0, 1]
            }[key];

            if (movement) {
                event.preventDefault();
                this.moveSelection(movement[0], movement[1]);
            }
        });
    }

    toggleNotesMode() {
        this.notesMode = !this.notesMode;
        this.notesButton?.setAttribute("aria-pressed", String(this.notesMode));
    }

    moveSelection(rowDelta, colDelta) {
        const nextRow = Math.max(0, Math.min(8, this.selected.row + rowDelta));
        const nextCol = Math.max(0, Math.min(8, this.selected.col + colDelta));
        this.selected = { row: nextRow, col: nextCol };
        this.render();
        this.focusSelectedButton();
    }

    focusSelectedButton() {
        const button = this.boardButtons[this.selected.row]?.[this.selected.col];
        button?.focus();
    }

    isEditable(row, col) {
        return this.puzzle[row][col] === 0;
    }

    applyDigit(digit) {
        const { row, col } = this.selected;
        if (!this.isEditable(row, col)) {
            return;
        }

        if (this.notesMode) {
            const noteSet = this.notes[row][col];
            if (noteSet.has(digit)) {
                noteSet.delete(digit);
            } else {
                noteSet.add(digit);
            }
        } else {
            this.current[row][col] = digit;
            this.notes[row][col].clear();
        }

        this.render();
        if (this.isSolved()) {
            this.setStatus(this.labels.statusSolved);
        } else {
            this.setStatus(this.labels.statusReady);
        }
    }

    clearSelectedCell() {
        const { row, col } = this.selected;
        if (!this.isEditable(row, col)) {
            return;
        }

        if (this.notesMode) {
            this.notes[row][col].clear();
        } else {
            this.current[row][col] = 0;
        }

        this.render();
    }

    getConflictCells() {
        const conflicts = new Set();

        for (let row = 0; row < 9; row += 1) {
            for (let col = 0; col < 9; col += 1) {
                const value = this.current[row][col];
                if (!value) {
                    continue;
                }

                this.current[row][col] = 0;
                const valid = isPlacementValid(this.current, row, col, value);
                this.current[row][col] = value;
                if (!valid) {
                    conflicts.add(`${row}-${col}`);
                }
            }
        }

        return conflicts;
    }

    isSolved() {
        return gridToKey(this.current) === gridToKey(this.solution);
    }

    checkBoard() {
        if (this.isSolved()) {
            this.setStatus(this.labels.statusSolved);
            this.render();
            return;
        }

        const conflicts = this.getConflictCells();
        if (conflicts.size > 0) {
            this.setStatus(this.labels.statusInvalid);
            this.render(conflicts);
            return;
        }

        this.setStatus(this.labels.statusIncomplete);
        this.render();
    }

    setStatus(text) {
        if (this.statusElement) {
            this.statusElement.textContent = text;
        }
    }

    render(conflicts = this.getConflictCells()) {
        this.renderBoard(conflicts);
        this.renderPad();
    }

    renderBoard(conflicts) {
        this.boardElement.innerHTML = "";
        this.boardButtons = Array.from({ length: 9 }, () => Array(9).fill(null));

        for (let row = 0; row < 9; row += 1) {
            for (let col = 0; col < 9; col += 1) {
                const button = document.createElement("button");
                const value = this.current[row][col];
                const selected = this.selected.row === row && this.selected.col === col;
                const related = sameGroup(this.selected.row, this.selected.col, row, col);

                button.type = "button";
                button.className = "sudoku-cell";
                button.dataset.row = String(row);
                button.dataset.col = String(col);
                button.setAttribute("role", "gridcell");
                button.setAttribute("aria-label", `Row ${row + 1} Column ${col + 1}`);

                if (this.puzzle[row][col] !== 0) {
                    button.classList.add("is-given");
                }
                if (selected) {
                    button.classList.add("is-selected");
                } else if (related) {
                    button.classList.add("is-related");
                }
                if (conflicts.has(`${row}-${col}`)) {
                    button.classList.add("is-conflict");
                }

                if (value) {
                    button.textContent = String(value);
                } else {
                    const notes = this.notes[row][col];
                    if (notes.size > 0) {
                        const noteGrid = document.createElement("div");
                        noteGrid.className = "sudoku-cell__notes";
                        for (const digit of DIGITS) {
                            const span = document.createElement("span");
                            span.textContent = notes.has(digit) ? String(digit) : "";
                            noteGrid.appendChild(span);
                        }
                        button.appendChild(noteGrid);
                    } else {
                        button.innerHTML = "&nbsp;";
                    }
                }

                button.addEventListener("click", () => {
                    this.selected = { row, col };
                    this.render();
                });

                this.boardButtons[row][col] = button;
                this.boardElement.appendChild(button);
            }
        }
    }

    renderPad() {
        this.padElement.innerHTML = "";
        for (const digit of DIGITS) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "sudoku-pad__button";
            button.textContent = String(digit);
            button.addEventListener("click", () => this.applyDigit(digit));
            this.padElement.appendChild(button);
        }
    }
}

const root = document.getElementById("sudoku-app");
if (root) {
    new SudokuUI(root);
}
