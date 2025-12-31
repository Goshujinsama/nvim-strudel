---@mod strudel.theory.scales Music theory scale definitions
---@brief [[
---Defines musical scales including major, minor, modes, and pentatonics.
---Provides utilities for working with scales.
---@brief ]]

local M = {}

---Note names in order (using sharps)
---@type string[]
M.NOTE_NAMES = { 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B' }

---Note names using flats
---@type string[]
M.NOTE_NAMES_FLAT = { 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B' }

---Mapping from note name to pitch class
---@type table<string, number>
M.NOTE_TO_PC = {
  ['C'] = 0,
  ['C#'] = 1,
  ['Db'] = 1,
  ['D'] = 2,
  ['D#'] = 3,
  ['Eb'] = 3,
  ['E'] = 4,
  ['Fb'] = 4,
  ['E#'] = 5,
  ['F'] = 5,
  ['F#'] = 6,
  ['Gb'] = 6,
  ['G'] = 7,
  ['G#'] = 8,
  ['Ab'] = 8,
  ['A'] = 9,
  ['A#'] = 10,
  ['Bb'] = 10,
  ['B'] = 11,
  ['Cb'] = 11,
  ['B#'] = 0,
}

---@class Scale
---@field name string Display name of the scale
---@field intervals number[] Semitone intervals from root (0-indexed)
---@field mode_of? string Parent scale if this is a mode
---@field mode_degree? number Which degree of parent this mode starts on

---All supported scales
---@type table<string, Scale>
M.SCALES = {
  -- Major and natural minor
  major = {
    name = 'Major',
    intervals = { 0, 2, 4, 5, 7, 9, 11 },
  },
  natural_minor = {
    name = 'Natural Minor',
    intervals = { 0, 2, 3, 5, 7, 8, 10 },
  },
  harmonic_minor = {
    name = 'Harmonic Minor',
    intervals = { 0, 2, 3, 5, 7, 8, 11 },
  },
  melodic_minor = {
    name = 'Melodic Minor',
    intervals = { 0, 2, 3, 5, 7, 9, 11 },
  },

  -- Church modes
  ionian = {
    name = 'Ionian',
    intervals = { 0, 2, 4, 5, 7, 9, 11 },
    mode_of = 'major',
    mode_degree = 1,
  },
  dorian = {
    name = 'Dorian',
    intervals = { 0, 2, 3, 5, 7, 9, 10 },
    mode_of = 'major',
    mode_degree = 2,
  },
  phrygian = {
    name = 'Phrygian',
    intervals = { 0, 1, 3, 5, 7, 8, 10 },
    mode_of = 'major',
    mode_degree = 3,
  },
  lydian = {
    name = 'Lydian',
    intervals = { 0, 2, 4, 6, 7, 9, 11 },
    mode_of = 'major',
    mode_degree = 4,
  },
  mixolydian = {
    name = 'Mixolydian',
    intervals = { 0, 2, 4, 5, 7, 9, 10 },
    mode_of = 'major',
    mode_degree = 5,
  },
  aeolian = {
    name = 'Aeolian',
    intervals = { 0, 2, 3, 5, 7, 8, 10 },
    mode_of = 'major',
    mode_degree = 6,
  },
  locrian = {
    name = 'Locrian',
    intervals = { 0, 1, 3, 5, 6, 8, 10 },
    mode_of = 'major',
    mode_degree = 7,
  },

  -- Pentatonic scales
  pentatonic_major = {
    name = 'Major Pentatonic',
    intervals = { 0, 2, 4, 7, 9 },
  },
  pentatonic_minor = {
    name = 'Minor Pentatonic',
    intervals = { 0, 3, 5, 7, 10 },
  },

  -- Blues scales
  blues = {
    name = 'Blues',
    intervals = { 0, 3, 5, 6, 7, 10 },
  },
  blues_major = {
    name = 'Major Blues',
    intervals = { 0, 2, 3, 4, 7, 9 },
  },

  -- Other common scales
  whole_tone = {
    name = 'Whole Tone',
    intervals = { 0, 2, 4, 6, 8, 10 },
  },
  chromatic = {
    name = 'Chromatic',
    intervals = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 },
  },
  diminished = {
    name = 'Diminished (Half-Whole)',
    intervals = { 0, 1, 3, 4, 6, 7, 9, 10 },
  },
  diminished_whole_half = {
    name = 'Diminished (Whole-Half)',
    intervals = { 0, 2, 3, 5, 6, 8, 9, 11 },
  },

  -- Jazz scales
  bebop_dominant = {
    name = 'Bebop Dominant',
    intervals = { 0, 2, 4, 5, 7, 9, 10, 11 },
  },
  bebop_major = {
    name = 'Bebop Major',
    intervals = { 0, 2, 4, 5, 7, 8, 9, 11 },
  },
  altered = {
    name = 'Altered',
    intervals = { 0, 1, 3, 4, 6, 8, 10 },
  },
}

---Convert pitch class (0-11) to note name
---@param pc number Pitch class (0-11)
---@param prefer_flat? boolean Use flat names instead of sharp
---@return string Note name
function M.pc_to_note_name(pc, prefer_flat)
  pc = pc % 12
  if prefer_flat then
    return M.NOTE_NAMES_FLAT[pc + 1]
  end
  return M.NOTE_NAMES[pc + 1]
end

---Convert note name to pitch class (0-11)
---@param note string Note name (e.g., "C", "F#", "Bb")
---@return number|nil Pitch class or nil if invalid
function M.note_name_to_pc(note)
  -- Normalize: capitalize first letter, handle 's' for sharp
  local normalized = note:sub(1, 1):upper() .. note:sub(2):lower():gsub('s', '#')
  return M.NOTE_TO_PC[normalized]
end

---Get all pitch classes in a scale
---@param root string|number Root note (name or pitch class)
---@param scale_name string Scale name from SCALES
---@return number[]|nil Pitch classes in the scale, or nil if invalid
function M.get_scale_pcs(root, scale_name)
  local scale = M.SCALES[scale_name]
  if not scale then
    return nil
  end

  local root_pc
  if type(root) == 'string' then
    root_pc = M.note_name_to_pc(root)
    if not root_pc then
      return nil
    end
  else
    root_pc = root % 12
  end

  local pcs = {}
  for _, interval in ipairs(scale.intervals) do
    table.insert(pcs, (root_pc + interval) % 12)
  end
  return pcs
end

---Get all note names in a scale
---@param root string|number Root note (name or pitch class)
---@param scale_name string Scale name from SCALES
---@param prefer_flat? boolean Use flat names
---@return string[]|nil Note names in the scale
function M.get_scale_notes(root, scale_name, prefer_flat)
  local pcs = M.get_scale_pcs(root, scale_name)
  if not pcs then
    return nil
  end

  local notes = {}
  for _, pc in ipairs(pcs) do
    table.insert(notes, M.pc_to_note_name(pc, prefer_flat))
  end
  return notes
end

---Check if a pitch class is in a scale
---@param pc number Pitch class (0-11)
---@param root string|number Root note
---@param scale_name string Scale name
---@return boolean
function M.pc_in_scale(pc, root, scale_name)
  local scale_pcs = M.get_scale_pcs(root, scale_name)
  if not scale_pcs then
    return false
  end

  pc = pc % 12
  for _, scale_pc in ipairs(scale_pcs) do
    if scale_pc == pc then
      return true
    end
  end
  return false
end

---Check if a note is in a scale
---@param note string Note name
---@param root string|number Root note
---@param scale_name string Scale name
---@return boolean
function M.note_in_scale(note, root, scale_name)
  local pc = M.note_name_to_pc(note)
  if not pc then
    return false
  end
  return M.pc_in_scale(pc, root, scale_name)
end

---Get the scale degree of a pitch class in a scale (1-indexed)
---@param pc number Pitch class (0-11)
---@param root string|number Root note
---@param scale_name string Scale name
---@return number|nil Scale degree (1-7) or nil if not in scale
function M.get_scale_degree(pc, root, scale_name)
  local scale_pcs = M.get_scale_pcs(root, scale_name)
  if not scale_pcs then
    return nil
  end

  pc = pc % 12
  for i, scale_pc in ipairs(scale_pcs) do
    if scale_pc == pc then
      return i
    end
  end
  return nil
end

---Get the pitch class for a scale degree
---@param degree number Scale degree (1-indexed)
---@param root string|number Root note
---@param scale_name string Scale name
---@return number|nil Pitch class or nil if invalid
function M.degree_to_pc(degree, root, scale_name)
  local scale_pcs = M.get_scale_pcs(root, scale_name)
  if not scale_pcs then
    return nil
  end

  -- Handle negative and out-of-range degrees by wrapping
  local num_degrees = #scale_pcs
  degree = ((degree - 1) % num_degrees) + 1
  return scale_pcs[degree]
end

---Get list of all scale names
---@return string[]
function M.get_scale_names()
  local names = {}
  for name, _ in pairs(M.SCALES) do
    table.insert(names, name)
  end
  table.sort(names)
  return names
end

---Get characteristic intervals of a scale (what makes it unique)
---@param scale_name string Scale name
---@return number[]|nil Intervals that distinguish this scale
function M.get_characteristic_intervals(scale_name)
  local scale = M.SCALES[scale_name]
  if not scale then
    return nil
  end

  -- Return intervals as a set for comparison
  return vim.tbl_map(function(i)
    return i
  end, scale.intervals)
end

---Compare two pitch class sets for similarity
---@param pcs1 number[] First set of pitch classes
---@param pcs2 number[] Second set of pitch classes
---@return number Similarity score 0-1
function M.pitch_class_similarity(pcs1, pcs2)
  local set1 = {}
  local set2 = {}

  for _, pc in ipairs(pcs1) do
    set1[pc % 12] = true
  end
  for _, pc in ipairs(pcs2) do
    set2[pc % 12] = true
  end

  local intersection = 0
  local union = 0

  for pc = 0, 11 do
    local in1 = set1[pc] or false
    local in2 = set2[pc] or false
    if in1 and in2 then
      intersection = intersection + 1
    end
    if in1 or in2 then
      union = union + 1
    end
  end

  if union == 0 then
    return 0
  end
  return intersection / union
end

return M
