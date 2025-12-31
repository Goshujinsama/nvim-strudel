---@mod strudel.theory.analyzer Key and scale detection
---@brief [[
---Analyzes parsed musical content to detect the key and scale.
---Uses pitch class set matching algorithm.
---@brief ]]

local scales = require('strudel.theory.scales')
local chords = require('strudel.theory.chords')
local parser = require('strudel.theory.parser')

local M = {}

---@class KeyAnalysisResult
---@field root string Root note name (e.g., "C", "F#")
---@field root_pc number Root pitch class (0-11)
---@field scale string Scale name (e.g., "major", "natural_minor")
---@field scale_info table Scale definition from scales.SCALES
---@field confidence number Confidence score (0-1)
---@field all_matches table[] All matching scales sorted by confidence
---@field pitch_classes number[] Pitch classes used in analysis
---@field note_count number Number of notes analyzed
---@field source_type string Type of pattern analyzed

-- Priority scales to check first (most common)
local PRIORITY_SCALES = {
  'major',
  'natural_minor',
  'dorian',
  'mixolydian',
  'pentatonic_major',
  'pentatonic_minor',
  'blues',
  'harmonic_minor',
  'melodic_minor',
  'phrygian',
  'lydian',
  'locrian',
}

---Calculate how well a set of pitch classes matches a scale
---@param pitch_classes table<number, number> Map of pc -> occurrence count
---@param root number Root pitch class
---@param scale table Scale definition
---@return number score, number in_scale, number out_of_scale, number coverage
local function calculate_scale_match(pitch_classes, root, scale)
  -- Build set of scale pitch classes
  local scale_pcs = {}
  for _, interval in ipairs(scale.intervals) do
    scale_pcs[(root + interval) % 12] = true
  end

  local in_scale = 0
  local out_of_scale = 0
  local total_notes = 0
  local coverage = 0

  -- Count notes in vs out of scale
  for pc, count in pairs(pitch_classes) do
    total_notes = total_notes + count
    if scale_pcs[pc] then
      in_scale = in_scale + count
    else
      out_of_scale = out_of_scale + count
    end
  end

  -- Count how many scale degrees are covered
  for pc, _ in pairs(scale_pcs) do
    if pitch_classes[pc] then
      coverage = coverage + 1
    end
  end

  if total_notes == 0 then
    return 0, 0, 0, 0
  end

  -- Calculate score
  -- Weight: notes in scale (70%), coverage (30%), penalize out of scale
  local score = (in_scale / total_notes) * 0.7 + (coverage / #scale.intervals) * 0.3
      - (out_of_scale / total_notes) * 0.5

  return math.max(0, math.min(1, score)), in_scale, out_of_scale, coverage
end

---Analyze pitch classes to detect key and scale
---@param pitch_classes number[] List of pitch classes (can have duplicates)
---@param opts? table Options
---@return KeyAnalysisResult|nil
function M.analyze_pitch_classes(pitch_classes, opts)
  opts = opts or {}

  if #pitch_classes == 0 then
    return nil
  end

  -- Count occurrences of each pitch class
  local pc_counts = {}
  for _, pc in ipairs(pitch_classes) do
    local normalized = pc % 12
    pc_counts[normalized] = (pc_counts[normalized] or 0) + 1
  end

  -- Get unique pitch classes
  local unique_pcs = {}
  for pc, _ in pairs(pc_counts) do
    table.insert(unique_pcs, pc)
  end
  table.sort(unique_pcs)

  local matches = {}

  -- Try each possible root (0-11)
  for root = 0, 11 do
    -- Try priority scales first, then others
    local scales_to_check = {}
    for _, name in ipairs(PRIORITY_SCALES) do
      if scales.SCALES[name] then
        scales_to_check[name] = true
        local scale = scales.SCALES[name]
        local score, in_scale, out_of_scale, coverage = calculate_scale_match(pc_counts, root, scale)

        if score > 0.3 then
          table.insert(matches, {
            root = scales.pc_to_note_name(root),
            root_pc = root,
            scale = name,
            scale_info = scale,
            confidence = score,
            in_scale = in_scale,
            out_of_scale = out_of_scale,
            coverage = coverage,
          })
        end
      end
    end

    -- Check remaining scales
    for name, scale in pairs(scales.SCALES) do
      if not scales_to_check[name] then
        local score, in_scale, out_of_scale, coverage = calculate_scale_match(pc_counts, root, scale)

        if score > 0.4 then -- Higher threshold for non-priority scales
          table.insert(matches, {
            root = scales.pc_to_note_name(root),
            root_pc = root,
            scale = name,
            scale_info = scale,
            confidence = score,
            in_scale = in_scale,
            out_of_scale = out_of_scale,
            coverage = coverage,
          })
        end
      end
    end
  end

  -- Sort by confidence (descending)
  table.sort(matches, function(a, b)
    return a.confidence > b.confidence
  end)

  -- Apply heuristics to boost certain matches
  for _, match in ipairs(matches) do
    -- Boost if first/last notes match root
    if opts.first_pc and opts.first_pc == match.root_pc then
      match.confidence = math.min(1, match.confidence + 0.1)
    end
    if opts.last_pc and opts.last_pc == match.root_pc then
      match.confidence = math.min(1, match.confidence + 0.05)
    end

    -- Boost major/minor for high coverage
    if match.coverage >= 5 and (match.scale == 'major' or match.scale == 'natural_minor') then
      match.confidence = math.min(1, match.confidence + 0.05)
    end
  end

  -- Re-sort after heuristics
  table.sort(matches, function(a, b)
    return a.confidence > b.confidence
  end)

  if #matches == 0 then
    -- Default to C major with low confidence
    return {
      root = 'C',
      root_pc = 0,
      scale = 'major',
      scale_info = scales.SCALES.major,
      confidence = 0.1,
      all_matches = {},
      pitch_classes = unique_pcs,
      note_count = #pitch_classes,
      source_type = opts.source_type or 'unknown',
    }
  end

  local best = matches[1]
  return {
    root = best.root,
    root_pc = best.root_pc,
    scale = best.scale,
    scale_info = best.scale_info,
    confidence = best.confidence,
    all_matches = matches,
    pitch_classes = unique_pcs,
    note_count = #pitch_classes,
    source_type = opts.source_type or 'unknown',
  }
end

---Analyze a parse result for key/scale
---@param parse_result ParseResult
---@return KeyAnalysisResult|nil
function M.analyze(parse_result)
  local pitch_classes = {}
  local first_pc = nil
  local last_pc = nil

  -- Collect pitch classes from notes
  for i, note in ipairs(parse_result.notes) do
    if note.pc then
      table.insert(pitch_classes, note.pc)
      if i == 1 then
        first_pc = note.pc
      end
      last_pc = note.pc
    end
  end

  -- Collect pitch classes from chords
  for _, chord in ipairs(parse_result.chords) do
    if chord.chord then
      for _, pc in ipairs(chord.chord.pcs) do
        table.insert(pitch_classes, pc)
      end
      -- Root of first chord is likely tonic
      if not first_pc then
        first_pc = chord.chord.root_pc
      end
      last_pc = chord.chord.root_pc
    end
  end

  -- For degree-based patterns, we need to make assumptions
  -- Assume C as reference if we only have degrees
  if #pitch_classes == 0 and #parse_result.degrees > 0 then
    -- Default to C major scale degrees
    for i, deg in ipairs(parse_result.degrees) do
      -- Map degree to pitch class (assuming C major)
      -- Degrees can be negative, wrap them
      local normalized_deg = ((deg % 7) + 7) % 7
      local c_major = { 0, 2, 4, 5, 7, 9, 11 }
      local pc = c_major[normalized_deg + 1] or 0
      table.insert(pitch_classes, pc)
      if i == 1 then
        first_pc = pc
      end
      last_pc = pc
    end
  end

  return M.analyze_pitch_classes(pitch_classes, {
    first_pc = first_pc,
    last_pc = last_pc,
    source_type = parse_result.source_type,
  })
end

---Analyze a single line
---@param line string Line to analyze
---@return KeyAnalysisResult|nil
function M.analyze_line(line)
  local parse_result = parser.parse_line(line)
  return M.analyze(parse_result)
end

---Analyze a buffer
---@param bufnr? number Buffer number (0 for current)
---@return KeyAnalysisResult|nil
function M.analyze_buffer(bufnr)
  local parse_result = parser.parse_buffer(bufnr)
  return M.analyze(parse_result)
end

---Analyze a selection
---@param start_line number Start line (1-indexed)
---@param end_line number End line (1-indexed)
---@param bufnr? number Buffer number
---@return KeyAnalysisResult|nil
function M.analyze_selection(start_line, end_line, bufnr)
  local parse_result = parser.parse_selection(start_line, end_line, bufnr)
  return M.analyze(parse_result)
end

---Detect key from chord progression
---@param chord_symbols string[] List of chord symbols
---@return KeyAnalysisResult|nil
function M.analyze_progression(chord_symbols)
  local pitch_classes = {}
  local chord_roots = {}

  for _, symbol in ipairs(chord_symbols) do
    local chord = chords.parse_chord(symbol)
    if chord then
      table.insert(chord_roots, chord.root_pc)
      for _, pc in ipairs(chord.pcs) do
        table.insert(pitch_classes, pc)
      end
    end
  end

  local result = M.analyze_pitch_classes(pitch_classes)

  -- Boost confidence if chord roots suggest the key
  if result and #chord_roots > 0 then
    -- Count how often each root appears
    local root_counts = {}
    for _, root in ipairs(chord_roots) do
      root_counts[root] = (root_counts[root] or 0) + 1
    end

    -- If the detected root is the most common chord root, boost confidence
    local max_count = 0
    local most_common_root = nil
    for root, count in pairs(root_counts) do
      if count > max_count then
        max_count = count
        most_common_root = root
      end
    end

    if most_common_root == result.root_pc then
      result.confidence = math.min(1, result.confidence + 0.1)
    end
  end

  return result
end

---Format analysis result as a readable string
---@param result KeyAnalysisResult
---@return string
function M.format_result(result)
  local confidence_pct = math.floor(result.confidence * 100)
  local scale_name = result.scale_info.name or result.scale
  return string.format('%s %s (%d%% confidence)', result.root, scale_name, confidence_pct)
end

return M
