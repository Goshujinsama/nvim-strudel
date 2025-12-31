---@mod strudel.theory.intervals Music theory interval definitions
---@brief [[
---Defines musical intervals and provides conversion utilities.
---Intervals are the building blocks for scales and chords.
---@brief ]]

local M = {}

---@class Interval
---@field semitones number Number of semitones
---@field name string Short name (e.g., "P5", "m3")
---@field full_name string Full name (e.g., "Perfect Fifth")

---All standard intervals within an octave
---@type table<string, Interval>
M.INTERVALS = {
  P1 = { semitones = 0, name = 'P1', full_name = 'Perfect Unison' },
  m2 = { semitones = 1, name = 'm2', full_name = 'Minor Second' },
  M2 = { semitones = 2, name = 'M2', full_name = 'Major Second' },
  m3 = { semitones = 3, name = 'm3', full_name = 'Minor Third' },
  M3 = { semitones = 4, name = 'M3', full_name = 'Major Third' },
  P4 = { semitones = 5, name = 'P4', full_name = 'Perfect Fourth' },
  TT = { semitones = 6, name = 'TT', full_name = 'Tritone' },
  d5 = { semitones = 6, name = 'd5', full_name = 'Diminished Fifth' },
  A4 = { semitones = 6, name = 'A4', full_name = 'Augmented Fourth' },
  P5 = { semitones = 7, name = 'P5', full_name = 'Perfect Fifth' },
  m6 = { semitones = 8, name = 'm6', full_name = 'Minor Sixth' },
  A5 = { semitones = 8, name = 'A5', full_name = 'Augmented Fifth' },
  M6 = { semitones = 9, name = 'M6', full_name = 'Major Sixth' },
  d7 = { semitones = 9, name = 'd7', full_name = 'Diminished Seventh' },
  m7 = { semitones = 10, name = 'm7', full_name = 'Minor Seventh' },
  M7 = { semitones = 11, name = 'M7', full_name = 'Major Seventh' },
  P8 = { semitones = 12, name = 'P8', full_name = 'Perfect Octave' },
  -- Extended intervals (for 9ths, 11ths, 13ths)
  m9 = { semitones = 13, name = 'm9', full_name = 'Minor Ninth' },
  M9 = { semitones = 14, name = 'M9', full_name = 'Major Ninth' },
  m10 = { semitones = 15, name = 'm10', full_name = 'Minor Tenth' },
  M10 = { semitones = 16, name = 'M10', full_name = 'Major Tenth' },
  P11 = { semitones = 17, name = 'P11', full_name = 'Perfect Eleventh' },
  A11 = { semitones = 18, name = 'A11', full_name = 'Augmented Eleventh' },
  P12 = { semitones = 19, name = 'P12', full_name = 'Perfect Twelfth' },
  m13 = { semitones = 20, name = 'm13', full_name = 'Minor Thirteenth' },
  M13 = { semitones = 21, name = 'M13', full_name = 'Major Thirteenth' },
}

---Mapping from semitones to common interval name (prefers simpler names)
---@type table<number, string>
local semitone_to_name = {
  [0] = 'P1',
  [1] = 'm2',
  [2] = 'M2',
  [3] = 'm3',
  [4] = 'M3',
  [5] = 'P4',
  [6] = 'TT',
  [7] = 'P5',
  [8] = 'm6',
  [9] = 'M6',
  [10] = 'm7',
  [11] = 'M7',
  [12] = 'P8',
  [13] = 'm9',
  [14] = 'M9',
  [15] = 'm10',
  [16] = 'M10',
  [17] = 'P11',
  [18] = 'A11',
  [19] = 'P12',
  [20] = 'm13',
  [21] = 'M13',
}

---Convert semitones to interval name
---@param semitones number
---@return string|nil interval_name
function M.semitones_to_interval(semitones)
  return semitone_to_name[semitones]
end

---Convert interval name to semitones
---@param name string Interval name (e.g., "P5", "m3")
---@return number|nil semitones
function M.interval_to_semitones(name)
  local interval = M.INTERVALS[name]
  return interval and interval.semitones or nil
end

---Get interval between two pitch classes (0-11)
---@param pc1 number First pitch class
---@param pc2 number Second pitch class
---@return number semitones (always positive, 0-11)
function M.pitch_class_interval(pc1, pc2)
  return (pc2 - pc1) % 12
end

---Get interval between two MIDI notes
---@param midi1 number First MIDI note
---@param midi2 number Second MIDI note
---@return number semitones (can be negative)
function M.midi_interval(midi1, midi2)
  return midi2 - midi1
end

---Transpose a pitch class by an interval
---@param pc number Pitch class (0-11)
---@param semitones number Semitones to transpose
---@return number New pitch class (0-11)
function M.transpose_pc(pc, semitones)
  return (pc + semitones) % 12
end

---Transpose a MIDI note by an interval
---@param midi number MIDI note number
---@param semitones number Semitones to transpose
---@return number New MIDI note number
function M.transpose_midi(midi, semitones)
  return midi + semitones
end

---Check if an interval is consonant
---@param semitones number
---@return boolean
function M.is_consonant(semitones)
  local s = semitones % 12
  -- P1, m3, M3, P4, P5, m6, M6, P8 are consonant
  return s == 0 or s == 3 or s == 4 or s == 5 or s == 7 or s == 8 or s == 9 or s == 12
end

---Check if an interval is dissonant
---@param semitones number
---@return boolean
function M.is_dissonant(semitones)
  return not M.is_consonant(semitones)
end

---Get the inversion of an interval within an octave
---@param semitones number
---@return number Inverted interval semitones
function M.invert(semitones)
  return (12 - (semitones % 12)) % 12
end

return M
