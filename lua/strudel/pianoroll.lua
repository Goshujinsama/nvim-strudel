---@brief [[
--- Pianoroll/Punchcard ASCII visualization for Strudel patterns
--- Shows pattern events as an animated ASCII display in a split buffer
---@brief ]]

local client = require('strudel.client')
local config = require('strudel.config')
local utils = require('strudel.utils')

local M = {}

---@class PianorollState
---@field bufnr number|nil Buffer number
---@field winid number|nil Window ID
---@field timer uv_timer_t|nil Animation timer
---@field tracks table[] Current track data
---@field cycle number Current cycle
---@field phase number Phase within cycle (0-1)
---@field display_cycles number Number of cycles to display
---@field ns_id number Namespace for extmarks
---@field mode string Visualization mode: 'auto', 'tracks', 'notes', or 'drums'
---@field notes table[]|nil Note events for braille mode
---@field note_range table|nil {min, max} MIDI note range
---@field smooth boolean Smooth scrolling (playhead at left edge)
---@field playhead_position number Playhead position in display window (0-1)
---@field enabled boolean Whether pianoroll is enabled (user toggled on)
---@field is_playing boolean Whether playback is active
---@field callbacks_registered boolean Whether we've registered event callbacks

---@type PianorollState
local state = {
  bufnr = nil,
  winid = nil,
  timer = nil,
  tracks = {},
  cycle = 0,
  phase = 0,
  display_cycles = 2,
  ns_id = vim.api.nvim_create_namespace('strudel_pianoroll'),
  mode = 'auto', -- 'auto', 'tracks', 'notes', or 'drums'
  notes = nil,
  note_range = nil,
  smooth = true, -- smooth scrolling by default
  playhead_position = 0, -- 0-1, where playhead is in display window
  enabled = false, -- whether user has enabled pianoroll
  is_playing = false, -- whether playback is active
  callbacks_registered = false, -- whether event callbacks are registered
}

-- Unicode/ASCII characters for rendering
local CHARS = {
  event = '█',
  event_active = '▓',
  sustain = '░',
  empty = ' ',
  playhead = '▏',
  border_h = '─',
  border_v = '│',
  corner_tl = '┌',
  corner_tr = '┐',
  corner_bl = '└',
  corner_br = '┘',
  tick = '┬',
  tick_bottom = '┴',
}

-- Braille character encoding
-- Each braille char is a 2x4 grid of dots:
--   1 4    (bits: 0x01, 0x08)
--   2 5    (bits: 0x02, 0x10)
--   3 6    (bits: 0x04, 0x20)
--   7 8    (bits: 0x40, 0x80)
-- Base character is U+2800 (empty braille)
local BRAILLE_BASE = 0x2800
local BRAILLE_DOTS = {
  -- Left column (time position 0): rows 0-3 from top
  { 0x01, 0x02, 0x04, 0x40 },
  -- Right column (time position 1): rows 0-3 from top
  { 0x08, 0x10, 0x20, 0x80 },
}

---Convert note grid to braille character
---@param grid boolean[][] 2x4 grid [col][row] where col=1,2 and row=1-4
---@return string Single braille character
local function grid_to_braille(grid)
  local code = BRAILLE_BASE
  for col = 1, 2 do
    for row = 1, 4 do
      if grid[col] and grid[col][row] then
        code = code + BRAILLE_DOTS[col][row]
      end
    end
  end
  -- Convert code point to UTF-8 string
  if code < 0x80 then
    return string.char(code)
  elseif code < 0x800 then
    return string.char(
      0xC0 + math.floor(code / 64),
      0x80 + (code % 64)
    )
  else
    return string.char(
      0xE0 + math.floor(code / 4096),
      0x80 + math.floor((code % 4096) / 64),
      0x80 + (code % 64)
    )
  end
end

---Convert MIDI note number to note name
---@param midi number MIDI note number (0-127)
---@return string Note name like "C4", "D#5"
local function midi_to_note_name(midi)
  if not midi or type(midi) ~= 'number' then
    return '?'
  end
  local note_names = { 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B' }
  local octave = math.floor(midi / 12) - 1
  local index = (math.floor(midi) % 12) + 1
  local note = note_names[index]
  if not note then
    return '?'
  end
  return note .. octave
end

---Render notes as braille pianoroll
---@param notes table[] Array of {start, end, active, note} events
---@param note_range table {min, max} MIDI note range
---@param width number Content width in characters
---@param phase number Current phase (0-1)
---@return string[] lines
---@return table[] highlights
local function render_braille_notes(notes, note_range, width, phase)
  if not notes or #notes == 0 or not note_range then
    return {}, {}
  end

  local min_note = note_range.min
  local max_note = note_range.max
  
  -- Validate note range
  if not min_note or not max_note or min_note > max_note then
    return {}, {}
  end
  
  local note_count = max_note - min_note + 1
  if note_count <= 0 then
    return {}, {}
  end

  -- Each braille char represents 4 rows (notes) and 2 columns (time positions)
  -- So we need ceil(note_count / 4) terminal lines
  local num_rows = math.ceil(note_count / 4)
  
  -- Time resolution: each braille char = 2 time units
  -- So effective time columns = width * 2
  local time_cols = width * 2

  -- Create a 2D grid: [note][time] = {on, active}
  -- note is relative to min_note (0-indexed)
  -- time is 0 to time_cols-1
  local grid = {}
  for n = 0, note_count - 1 do
    grid[n] = {}
  end

  -- Fill grid from notes
  for _, event in ipairs(notes) do
    if event.note and type(event.note) == 'number' then
      local note_idx = math.floor(event.note - min_note)
      if note_idx >= 0 and note_idx < note_count and grid[note_idx] then
        local start_col = math.floor((event.start or 0) * time_cols)
        -- Use floor for end_col to make it exclusive (avoid overlap with next note)
        local end_col = math.floor((event['end'] or 0) * time_cols) - 1
        -- Only draw if note has visible duration (end > start after discretization)
        if end_col >= start_col then
          for t = math.max(0, start_col), math.min(time_cols - 1, end_col) do
            -- Preserve active state if already set (don't overwrite active with inactive)
            local existing = grid[note_idx][t]
            if not existing or event.active then
              grid[note_idx][t] = { on = true, active = event.active }
            end
          end
        end
      end
    end
  end

  local lines = {}
  local highlights = {}

  -- Render each row (4 notes per row)
  for row = 0, num_rows - 1 do
    local line_chars = {}
    local row_highlights = {}

    -- Notes for this row (bottom to top within the row for musical sense)
    -- Row 0 = highest notes, so we iterate from top
    local base_note = max_note - (row * 4)

    for col = 0, width - 1 do
      -- Each braille char covers 2 time positions
      local t0 = col * 2
      local t1 = col * 2 + 1

      -- Build the 2x4 grid for this braille char
      local braille_grid = { {}, {} }
      local has_active = false
      local has_any = false

      for sub_row = 1, 4 do
        local note_idx = (base_note - (sub_row - 1)) - min_note
        if note_idx >= 0 and note_idx < note_count and grid[note_idx] then
          -- Left column (t0)
          if grid[note_idx][t0] then
            braille_grid[1][sub_row] = true
            has_any = true
            if grid[note_idx][t0].active then
              has_active = true
            end
          end
          -- Right column (t1)
          if grid[note_idx][t1] then
            braille_grid[2][sub_row] = true
            has_any = true
            if grid[note_idx][t1].active then
              has_active = true
            end
          end
        end
      end

      local char = grid_to_braille(braille_grid)
      table.insert(line_chars, char)

      -- Track highlights for this character
      if has_any then
        -- Calculate byte position (braille chars are 3 bytes in UTF-8)
        local byte_start = (col) * 3
        local byte_end = byte_start + 3
        table.insert(row_highlights, {
          col_start = byte_start,
          col_end = byte_end,
          hl_group = has_active and 'StrudelPianoActive' or 'StrudelPianoEvent',
        })
      end
    end

    -- Add playhead highlight
    -- Playhead position comes from server (0-1 in display window)
    local playhead_col = math.floor(state.playhead_position * width)
    if playhead_col >= 0 and playhead_col < width then
      local byte_start = playhead_col * 3
      local byte_end = byte_start + 3
      table.insert(row_highlights, {
        col_start = byte_start,
        col_end = byte_end,
        hl_group = 'StrudelPianoPlayhead',
      })
    end

    table.insert(lines, table.concat(line_chars))
    table.insert(highlights, row_highlights)
  end

  return lines, highlights
end

---Generate note labels for braille rows
---@param note_range table {min, max}
---@param num_rows number Number of braille rows
---@return string[] labels
local function generate_note_labels(note_range, num_rows)
  local labels = {}
  if not note_range or not note_range.max or not note_range.min then
    return labels
  end
  local max_note = note_range.max

  for row = 0, num_rows - 1 do
    local top_note = max_note - (row * 4)
    local bottom_note = math.max(note_range.min, top_note - 3)
    local label = midi_to_note_name(top_note)
    if top_note ~= bottom_note then
      label = midi_to_note_name(bottom_note) .. '-' .. midi_to_note_name(top_note)
    end
    table.insert(labels, label)
  end

  return labels
end

---Create highlight groups for pianoroll
local function setup_highlights()
  -- Track name labels
  vim.api.nvim_set_hl(0, 'StrudelPianoTrack', {
    default = true,
    link = 'Identifier',
  })

  -- Event block (inactive)
  vim.api.nvim_set_hl(0, 'StrudelPianoEvent', {
    default = true,
    link = 'Function',
  })

  -- Active event (currently sounding)
  vim.api.nvim_set_hl(0, 'StrudelPianoActive', {
    default = true,
    link = 'Search',
  })

  -- Playhead line
  vim.api.nvim_set_hl(0, 'StrudelPianoPlayhead', {
    default = true,
    link = 'WarningMsg',
  })

  -- Border
  vim.api.nvim_set_hl(0, 'StrudelPianoBorder', {
    default = true,
    link = 'FloatBorder',
  })

  -- Empty space
  vim.api.nvim_set_hl(0, 'StrudelPianoEmpty', {
    default = true,
    link = 'Comment',
  })
  
  -- Hidden cursor for pianoroll window (invisible)
  vim.api.nvim_set_hl(0, 'StrudelPianoCursorHidden', {
    default = true,
    blend = 100,  -- Fully transparent
  })
end

---Fix cursor position in pianoroll window to prevent visual artifacts
---The cursor can appear to bounce around during rapid updates; fixing it
---to position 1,1 keeps it hidden in the border area
local function fix_cursor_position()
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    -- Only set cursor if this window has our buffer
    local win_buf = vim.api.nvim_win_get_buf(state.winid)
    if win_buf == state.bufnr then
      vim.api.nvim_win_set_cursor(state.winid, { 1, 0 })
    end
  end
end

---Get the current window width
---@return number
local function get_window_width()
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    return vim.api.nvim_win_get_width(state.winid)
  end
  return 64 -- fallback
end

---Get the maximum track name length
---@param tracks table[]
---@return number
local function max_track_name_len(tracks)
  local max_len = 4 -- minimum
  for _, track in ipairs(tracks) do
    max_len = math.max(max_len, #track.name)
  end
  return math.min(max_len, 12) -- cap at 12
end

---Render a single track line
---@param track table
---@param width number
---@param phase number
---@return string line
---@return table highlights {col_start, col_end, hl_group}[]
local function render_track_line(track, width, phase)
  local line = {}
  local highlights = {}

  -- Create empty line
  for i = 1, width do
    line[i] = CHARS.empty
  end

  -- Draw events
  for _, event in ipairs(track.events) do
    local start_col = math.floor(event.start * width) + 1
    local end_col = math.ceil(event["end"] * width)

    -- Clamp to bounds
    start_col = math.max(1, math.min(width, start_col))
    end_col = math.max(1, math.min(width, end_col))

    -- Draw the event
    for col = start_col, end_col do
      if event.active then
        line[col] = CHARS.event_active
      else
        line[col] = CHARS.event
      end
    end

    -- Add highlight
    table.insert(highlights, {
      col_start = start_col - 1,
      col_end = end_col,
      hl_group = event.active and 'StrudelPianoActive' or 'StrudelPianoEvent',
    })
  end

  -- Draw playhead
  -- Playhead position comes from server (0-1 in display window)
  local playhead_col = math.floor(state.playhead_position * width) + 1
  if playhead_col >= 1 and playhead_col <= width then
    -- Only replace if it's empty space
    if line[playhead_col] == CHARS.empty then
      line[playhead_col] = CHARS.playhead
    end
    table.insert(highlights, {
      col_start = playhead_col - 1,
      col_end = playhead_col,
      hl_group = 'StrudelPianoPlayhead',
    })
  end

  return table.concat(line), highlights
end

-- Forward declarations for mutually-referencing functions
local render_braille
local render_tracks
local render_drums

---Render the visualization to the buffer (track mode, braille note mode, or drums mode)
---@param tracks table[]
---@param cycle number
---@param phase number
local function render(tracks, cycle, phase)
  if not state.bufnr or not vim.api.nvim_buf_is_valid(state.bufnr) then
    return
  end

  local width = get_window_width()
  
  -- Determine which mode to use
  local use_notes = false
  local use_drums = false
  
  if state.mode == 'notes' then
    use_notes = state.notes and #state.notes > 0 and state.note_range
  elseif state.mode == 'drums' then
    -- Drums mode: group tracks as braille (4 per row)
    use_drums = tracks and #tracks > 0
  elseif state.mode == 'auto' then
    -- Auto mode: use notes if we have note data, otherwise drums if we have tracks
    if state.notes and #state.notes > 0 and state.note_range then
      use_notes = true
    elseif tracks and #tracks > 0 then
      use_drums = true
    end
  end
  -- else: 'tracks' mode, use original track display

  if use_notes then
    render_braille(cycle, phase, width)
  elseif use_drums then
    render_drums(tracks, cycle, phase, width)
  else
    render_tracks(tracks, cycle, phase, width)
  end
end

---Render in braille note mode
---@param cycle number
---@param phase number
---@param width number
render_braille = function(cycle, phase, width)
  local notes = state.notes
  local note_range = state.note_range
  
  if not notes or #notes == 0 or not note_range then
    -- Fall back to empty display
    render_tracks({}, cycle, phase, width)
    return
  end

  local note_count = note_range.max - note_range.min + 1
  local num_rows = math.ceil(note_count / 4)
  
  -- Generate labels
  local labels = generate_note_labels(note_range, num_rows)
  local label_width = 0
  for _, label in ipairs(labels) do
    label_width = math.max(label_width, #label)
  end
  label_width = math.min(label_width, 10) -- cap at 10

  local content_width = width - label_width - 3
  if content_width < 8 then
    content_width = 8
  end

  -- Render braille content
  local braille_lines, braille_highlights = render_braille_notes(
    notes, note_range, content_width, phase
  )

  local lines = {}
  local all_highlights = {}

  -- Header
  local header_line = CHARS.corner_tl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_tr
  table.insert(lines, header_line)

  -- Content lines
  for i, content in ipairs(braille_lines) do
    local label = labels[i] or ''
    label = label:sub(1, label_width)
    label = string.rep(' ', label_width - #label) .. label -- right-align

    local line = CHARS.border_v .. label .. CHARS.border_v .. content .. CHARS.border_v
    table.insert(lines, line)

    -- Adjust highlight positions for the label offset
    -- border_v is 3 bytes, label is label_width bytes, another border_v is 3 bytes
    local offset = 3 + label_width + 3
    for _, hl in ipairs(braille_highlights[i] or {}) do
      table.insert(all_highlights, {
        line = i, -- 1-indexed for the content line (0 is header)
        col_start = offset + hl.col_start,
        col_end = offset + hl.col_end,
        hl_group = hl.hl_group,
      })
    end

    -- Add label highlight (after first border_v which is 3 bytes)
    table.insert(all_highlights, {
      line = i,
      col_start = 3,
      col_end = 3 + label_width,
      hl_group = 'StrudelPianoTrack',
    })
  end

  -- Footer
  local footer_line = CHARS.corner_bl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick_bottom
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_br
  table.insert(lines, footer_line)

  -- Update buffer
  vim.api.nvim_set_option_value('modifiable', true, { buf = state.bufnr })
  vim.api.nvim_buf_set_lines(state.bufnr, 0, -1, false, lines)
  vim.api.nvim_set_option_value('modifiable', false, { buf = state.bufnr })
  fix_cursor_position()

  -- Clear old highlights
  vim.api.nvim_buf_clear_namespace(state.bufnr, state.ns_id, 0, -1)

  -- Apply highlights
  for _, hl in ipairs(all_highlights) do
    vim.api.nvim_buf_add_highlight(
      state.bufnr,
      state.ns_id,
      hl.hl_group,
      hl.line,
      hl.col_start,
      hl.col_end
    )
  end

  -- Border highlights (border chars are 3 bytes each in UTF-8)
  for i = 0, #lines - 1 do
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, 0, 3)
    local line_len = #lines[i + 1]
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, line_len - 3, line_len)
  end
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', 0, 0, -1)
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', #lines - 1, 0, -1)
end

---Render in drums braille mode (group 4 tracks per braille row)
---@param tracks table[]
---@param cycle number
---@param phase number
---@param width number
render_drums = function(tracks, cycle, phase, width)
  local braille = require('strudel.braille')
  
  if not tracks or #tracks == 0 then
    render_tracks({}, cycle, phase, width)
    return
  end
  
  local num_tracks = #tracks
  local num_rows = math.ceil(num_tracks / 4)
  
  -- Collect track names for labels
  local track_names = {}
  for _, track in ipairs(tracks) do
    table.insert(track_names, track.name)
  end
  
  -- Generate labels
  local labels = braille.generate_drum_labels(track_names, num_rows)
  local label_width = 0
  for _, label in ipairs(labels) do
    label_width = math.max(label_width, #label)
  end
  label_width = math.min(label_width, 12) -- cap at 12

  local content_width = width - label_width - 3
  if content_width < 8 then
    content_width = 8
  end

  local lines = {}
  local all_highlights = {}

  -- Header
  local header_line = CHARS.corner_tl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_tr
  table.insert(lines, header_line)

  -- Content lines (one per braille row = 4 tracks)
  for row = 0, num_rows - 1 do
    -- Which track indices belong to this row
    local track_indices = {}
    for i = 1, 4 do
      local idx = row * 4 + i
      if idx <= num_tracks then
        table.insert(track_indices, idx)
      end
    end
    
    -- Render this row of tracks
    local content, row_highlights = braille.render_drum_row(tracks, track_indices, content_width)
    
    local label = labels[row + 1] or ''
    label = label:sub(1, label_width)
    label = string.rep(' ', label_width - #label) .. label -- right-align

    local line = CHARS.border_v .. label .. CHARS.border_v .. content .. CHARS.border_v
    table.insert(lines, line)

    -- Adjust highlight positions for the label offset
    -- border_v is 3 bytes, label is label_width bytes, another border_v is 3 bytes
    local offset = 3 + label_width + 3
    for _, hl in ipairs(row_highlights) do
      -- Each braille char is 3 bytes in UTF-8
      local byte_start = hl.col * 3
      local byte_end = byte_start + 3
      table.insert(all_highlights, {
        line = row + 1, -- +1 for header
        col_start = offset + byte_start,
        col_end = offset + byte_end,
        hl_group = hl.active and 'StrudelPianoActive' or 'StrudelPianoEvent',
      })
    end

    -- Add playhead highlight
    -- Playhead position comes from server (0-1 in display window)
    local playhead_col = math.floor(state.playhead_position * content_width)
    if playhead_col >= 0 and playhead_col < content_width then
      local byte_start = playhead_col * 3
      local byte_end = byte_start + 3
      table.insert(all_highlights, {
        line = row + 1,
        col_start = offset + byte_start,
        col_end = offset + byte_end,
        hl_group = 'StrudelPianoPlayhead',
      })
    end

    -- Add label highlight (after first border_v which is 3 bytes)
    table.insert(all_highlights, {
      line = row + 1,
      col_start = 3,
      col_end = 3 + label_width,
      hl_group = 'StrudelPianoTrack',
    })
  end

  -- Footer
  local footer_line = CHARS.corner_bl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick_bottom
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_br
  table.insert(lines, footer_line)

  -- Update buffer
  vim.api.nvim_set_option_value('modifiable', true, { buf = state.bufnr })
  vim.api.nvim_buf_set_lines(state.bufnr, 0, -1, false, lines)
  vim.api.nvim_set_option_value('modifiable', false, { buf = state.bufnr })
  fix_cursor_position()

  -- Clear old highlights
  vim.api.nvim_buf_clear_namespace(state.bufnr, state.ns_id, 0, -1)

  -- Apply highlights
  for _, hl in ipairs(all_highlights) do
    vim.api.nvim_buf_add_highlight(
      state.bufnr,
      state.ns_id,
      hl.hl_group,
      hl.line,
      hl.col_start,
      hl.col_end
    )
  end

  -- Border highlights (border chars are 3 bytes each in UTF-8)
  for i = 0, #lines - 1 do
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, 0, 3)
    local line_len = #lines[i + 1]
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, line_len - 3, line_len)
  end
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', 0, 0, -1)
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', #lines - 1, 0, -1)
end

---Render in track mode (original behavior)
---@param tracks table[]
---@param cycle number
---@param phase number
---@param width number
render_tracks = function(tracks, cycle, phase, width)
  local label_width = max_track_name_len(tracks)
  local content_width = width - label_width - 3 -- -3 for "│" + "│" + "│"
  
  -- Ensure minimum content width
  if content_width < 16 then
    content_width = 16
  end

  local lines = {}
  local all_highlights = {}

  -- Header with cycle info
  local header = string.format(' Cycle: %.2f ', cycle)
  local header_line = CHARS.corner_tl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_tr
  table.insert(lines, header_line)

  -- Track lines
  for i, track in ipairs(tracks) do
    local label = track.name:sub(1, label_width)
    label = label .. string.rep(' ', label_width - #label) -- pad

    local content, highlights = render_track_line(track, content_width, phase)

    local line = CHARS.border_v .. label .. CHARS.border_v .. content .. CHARS.border_v
    table.insert(lines, line)

    -- Adjust highlight positions for the label offset
    -- border_v is 3 bytes, label is label_width bytes, another border_v is 3 bytes
    local offset = 3 + label_width + 3
    for _, hl in ipairs(highlights) do
      table.insert(all_highlights, {
        line = i, -- 0-indexed later
        col_start = offset + hl.col_start,
        col_end = offset + hl.col_end,
        hl_group = hl.hl_group,
      })
    end

    -- Add label highlight (after first border_v which is 3 bytes)
    table.insert(all_highlights, {
      line = i,
      col_start = 3,
      col_end = 3 + label_width,
      hl_group = 'StrudelPianoTrack',
    })
  end

  -- Footer
  local footer_line = CHARS.corner_bl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick_bottom
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_br
  table.insert(lines, footer_line)

  -- If no tracks, show a message
  if #tracks == 0 then
    local msg = 'No pattern playing'
    local inner_width = width - 2
    local padding_left = math.floor((inner_width - #msg) / 2)
    local padding_right = inner_width - #msg - padding_left
    lines = {
      CHARS.corner_tl .. string.rep(CHARS.border_h, inner_width) .. CHARS.corner_tr,
      CHARS.border_v .. string.rep(' ', padding_left) .. msg .. string.rep(' ', padding_right) .. CHARS.border_v,
      CHARS.corner_bl .. string.rep(CHARS.border_h, inner_width) .. CHARS.corner_br,
    }
    all_highlights = {}
  end

  -- Update buffer
  vim.api.nvim_set_option_value('modifiable', true, { buf = state.bufnr })
  vim.api.nvim_buf_set_lines(state.bufnr, 0, -1, false, lines)
  vim.api.nvim_set_option_value('modifiable', false, { buf = state.bufnr })
  fix_cursor_position()

  -- Clear old highlights
  vim.api.nvim_buf_clear_namespace(state.bufnr, state.ns_id, 0, -1)

  -- Apply highlights
  for _, hl in ipairs(all_highlights) do
    vim.api.nvim_buf_add_highlight(
      state.bufnr,
      state.ns_id,
      hl.hl_group,
      hl.line, -- already 0-indexed relative to tracks
      hl.col_start,
      hl.col_end
    )
  end

  -- Border highlights (border chars are 3 bytes each in UTF-8)
  for i = 0, #lines - 1 do
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, 0, 3)
    local line_len = #lines[i + 1]
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, line_len - 3, line_len)
  end
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', 0, 0, -1)
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', #lines - 1, 0, -1)
end

---Handle visualization data from server
---@param msg table
local function on_visualization(msg)
  state.tracks = msg.tracks or {}
  state.cycle = msg.cycle or 0
  state.phase = msg.phase or 0
  state.display_cycles = msg.displayCycles or 2
  state.notes = msg.notes
  state.note_range = msg.noteRange
  state.playhead_position = msg.playheadPosition or 0

  vim.schedule(function()
    render(state.tracks, state.cycle, state.phase)
  end)
end

---Request visualization data from server
local function request_visualization()
  if not client.is_connected() then
    return
  end

  client.send({
    type = 'queryVisualization',
    cycles = state.display_cycles,
    smooth = state.smooth,
  })
end

---Start the animation timer
local function start_timer()
  if state.timer then
    return
  end

  state.timer = vim.uv.new_timer()
  if state.timer then
    state.timer:start(0, 50, vim.schedule_wrap(function()
      request_visualization()
    end))
    utils.debug('Pianoroll animation started')
  end
end

---Stop the animation timer
local function stop_timer()
  if state.timer then
    state.timer:stop()
    state.timer:close()
    state.timer = nil
    utils.debug('Pianoroll animation stopped')
  end
end

-- Forward declaration for show_window
local show_window
local hide_window

---Handle status updates from server (play/pause/stop state)
---@param msg table
local function on_status(msg)
  local was_playing = state.is_playing
  state.is_playing = msg.playing or false
  
  if state.enabled then
    if state.is_playing and not was_playing then
      -- Started playing - show window
      vim.schedule(function()
        show_window()
      end)
    elseif not state.is_playing and was_playing then
      -- Stopped - hide window
      vim.schedule(function()
        hide_window()
      end)
    end
  end
end

---Handle visualization request from server (when code uses pianoroll/punchcard)
---@param msg table
local function on_enable_visualization(msg)
  -- Enable pianoroll when code requests visualization
  if not state.enabled then
    state.enabled = true
    utils.log('Pianoroll enabled by pattern')
    
    -- If currently playing, show immediately
    if state.is_playing then
      vim.schedule(function()
        show_window()
      end)
    end
  end
end

---Actually create and show the pianoroll window
show_window = function()
  -- Check if already open
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    return
  end

  setup_highlights()

  -- Create buffer
  state.bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_option_value('buftype', 'nofile', { buf = state.bufnr })
  vim.api.nvim_set_option_value('bufhidden', 'wipe', { buf = state.bufnr })
  vim.api.nvim_set_option_value('swapfile', false, { buf = state.bufnr })
  vim.api.nvim_buf_set_name(state.bufnr, 'Strudel Pianoroll')

  -- Load settings from config
  local cfg = config.get()
  local height = cfg.pianoroll and cfg.pianoroll.height or 10
  state.mode = cfg.pianoroll and cfg.pianoroll.mode or 'auto'
  state.display_cycles = cfg.pianoroll and cfg.pianoroll.display_cycles or 2

  -- Create horizontal split at bottom
  local current_win = vim.api.nvim_get_current_win()
  vim.cmd('botright ' .. height .. 'split')
  state.winid = vim.api.nvim_get_current_win()

  -- Set buffer in window
  vim.api.nvim_win_set_buf(state.winid, state.bufnr)

  -- Window options
  vim.api.nvim_set_option_value('number', false, { win = state.winid })
  vim.api.nvim_set_option_value('relativenumber', false, { win = state.winid })
  vim.api.nvim_set_option_value('signcolumn', 'no', { win = state.winid })
  vim.api.nvim_set_option_value('winfixheight', true, { win = state.winid })
  vim.api.nvim_set_option_value('cursorline', false, { win = state.winid })
  vim.api.nvim_set_option_value('cursorcolumn', false, { win = state.winid })
  vim.api.nvim_set_option_value('wrap', false, { win = state.winid })
  
  -- Hide cursor in pianoroll by using a blank cursor highlight
  -- This prevents visual artifacts from cursor position during rapid updates
  vim.api.nvim_set_option_value('winhighlight', 'Cursor:StrudelPianoCursorHidden,TermCursor:StrudelPianoCursorHidden', { win = state.winid })

  -- Return to original window
  vim.api.nvim_set_current_win(current_win)

  -- Start animation timer
  start_timer()

  -- Initial render
  render({}, 0, 0)

  -- Set up autocommand to clean up when buffer is wiped
  vim.api.nvim_create_autocmd('BufWipeout', {
    buffer = state.bufnr,
    once = true,
    callback = function()
      stop_timer()
      state.bufnr = nil
      state.winid = nil
      state.enabled = false  -- Mark as disabled so toggle will reopen
    end,
  })

  -- Set up autocommand to close pianoroll if it becomes the last window
  -- This prevents pianoroll from keeping Neovim alive
  vim.api.nvim_create_autocmd('WinClosed', {
    callback = function()
      vim.schedule(function()
        if not state.winid or not vim.api.nvim_win_is_valid(state.winid) then
          return
        end
        local wins = vim.api.nvim_list_wins()
        -- If pianoroll is the only window left, quit
        if #wins == 1 and wins[1] == state.winid then
          vim.cmd('quit')
        end
      end)
    end,
  })

  utils.debug('Pianoroll window shown')
end

---Hide the pianoroll window (but keep enabled state)
hide_window = function()
  stop_timer()

  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    -- Check if this is the last window - if so, quit nvim
    local wins = vim.api.nvim_list_wins()
    if #wins == 1 then
      vim.cmd('quit')
      return
    end
    -- Use pcall in case this is the last window (race condition)
    local ok, err = pcall(vim.api.nvim_win_close, state.winid, true)
    if not ok then
      -- If we can't close the window, it's probably the last one - quit
      if err and err:match('E444') then
        vim.cmd('quit')
        return
      end
    end
  end

  state.winid = nil
  state.bufnr = nil

  utils.debug('Pianoroll window hidden')
end

---Create the pianoroll buffer and window
function M.open()
  state.enabled = true
  
  -- Ensure callbacks are registered
  M.init()
  
  -- Only show window if currently playing
  if state.is_playing then
    show_window()
    utils.log('Pianoroll enabled (playing)')
  else
    utils.log('Pianoroll enabled (will show when playing)')
  end
end

---Close the pianoroll window
function M.close()
  state.enabled = false
  hide_window()
  utils.log('Pianoroll disabled')
end

---Toggle the pianoroll window
function M.toggle()
  if state.enabled then
    M.close()
  else
    M.open()
  end
end

---Check if pianoroll is open
---@return boolean
function M.is_open()
  return state.winid ~= nil and vim.api.nvim_win_is_valid(state.winid)
end

---Check if pianoroll is enabled
---@return boolean
function M.is_enabled()
  return state.enabled
end

---Set the number of cycles to display
---@param cycles number
function M.set_display_cycles(cycles)
  state.display_cycles = math.max(1, math.min(8, cycles))
end

---Set the visualization mode
---@param mode string 'auto', 'tracks', 'notes', or 'drums'
function M.set_mode(mode)
  if mode == 'auto' or mode == 'tracks' or mode == 'notes' or mode == 'drums' then
    state.mode = mode
    utils.log('Pianoroll mode: ' .. mode)
  else
    utils.log('Invalid pianoroll mode: ' .. tostring(mode))
  end
end

---Get the current visualization mode
---@return string
function M.get_mode()
  return state.mode
end

---Set smooth scrolling mode
---@param enabled boolean
function M.set_smooth(enabled)
  state.smooth = enabled
  utils.log('Pianoroll smooth scrolling: ' .. (enabled and 'on' or 'off'))
end

---Get smooth scrolling mode
---@return boolean
function M.get_smooth()
  return state.smooth
end

---Toggle smooth scrolling
function M.toggle_smooth()
  state.smooth = not state.smooth
  utils.log('Pianoroll smooth scrolling: ' .. (state.smooth and 'on' or 'off'))
end

---Initialize pianoroll callbacks (called at plugin setup)
---This ensures we receive visualization requests from patterns
function M.init()
  if state.callbacks_registered then
    return
  end
  
  client.on('visualization', on_visualization)
  client.on('status', on_status)
  client.on('enableVisualization', on_enable_visualization)
  state.callbacks_registered = true
  
  utils.debug('Pianoroll callbacks registered')
end

return M
