local utils = require('strudel.utils')
local config = require('strudel.config')

local M = {}

---@type 'snacks'|'telescope'|nil
local picker_backend = nil

---Detect available picker backend
---@return 'snacks'|'telescope'|nil
local function detect_backend()
  local cfg = config.get()

  if cfg.picker == 'snacks' then
    if utils.has_module('snacks') then
      return 'snacks'
    end
    utils.warn('Snacks.nvim not available, falling back')
  elseif cfg.picker == 'telescope' then
    if utils.has_module('telescope') then
      return 'telescope'
    end
    utils.warn('Telescope.nvim not available, falling back')
  end

  -- Auto-detect
  if utils.has_module('snacks') then
    return 'snacks'
  elseif utils.has_module('telescope') then
    return 'telescope'
  end

  return nil
end

---Get the picker backend
---@return 'snacks'|'telescope'|nil
function M.get_backend()
  if not picker_backend then
    picker_backend = detect_backend()
  end
  return picker_backend
end

---Open a picker with the given items
---@param opts { title: string, items: table[], on_select: function, preview?: boolean }
function M.pick(opts)
  local backend = M.get_backend()

  if not backend then
    utils.error('No picker backend available. Install snacks.nvim or telescope.nvim')
    return
  end

  if backend == 'snacks' then
    M.pick_snacks(opts)
  else
    M.pick_telescope(opts)
  end
end

---Snacks picker implementation
---@param opts { title: string, items: table[], on_select: function, preview?: boolean }
function M.pick_snacks(opts)
  local ok, snacks = pcall(require, 'snacks')
  if not ok then
    utils.error('Snacks.nvim not available')
    return
  end

  local picker_opts = {
    title = opts.title,
    items = opts.items,
    format = 'text',
    confirm = function(picker, item)
      picker:close()
      if item and opts.on_select then
        opts.on_select(item)
      end
    end,
  }

  -- Hide preview for items without files
  if opts.preview == false then
    picker_opts.layout = {
      preset = 'select',
      hidden = { 'preview' },
    }
  end

  snacks.picker.pick(picker_opts)
end

---Telescope picker implementation
---@param opts { title: string, items: table[], on_select: function }
function M.pick_telescope(opts)
  local ok, pickers = pcall(require, 'telescope.pickers')
  if not ok then
    utils.error('Telescope.nvim not available')
    return
  end

  local finders = require('telescope.finders')
  local conf = require('telescope.config').values
  local actions = require('telescope.actions')
  local action_state = require('telescope.actions.state')

  pickers
    .new({}, {
      prompt_title = opts.title,
      finder = finders.new_table({
        results = opts.items,
        entry_maker = function(item)
          return {
            value = item,
            display = item.text or item.name or tostring(item),
            ordinal = item.text or item.name or tostring(item),
          }
        end,
      }),
      sorter = conf.generic_sorter({}),
      attach_mappings = function(prompt_bufnr)
        actions.select_default:replace(function()
          local selection = action_state.get_selected_entry()
          actions.close(prompt_bufnr)
          if selection and opts.on_select then
            opts.on_select(selection.value)
          end
        end)
        return true
      end,
    })
    :find()
end

---Browse available samples
function M.samples()
  local client = require('strudel.client')

  if not client.is_connected() then
    utils.error('Not connected to server. Run :StrudelConnect first')
    return
  end

  -- Request samples from server
  client.get_samples(function(sample_names)
    if #sample_names == 0 then
      utils.warn('No samples loaded on server')
      return
    end

    local items = {}
    for _, name in ipairs(sample_names) do
      table.insert(items, { name = name, text = name })
    end

    M.pick({
      title = 'Strudel Samples (' .. #items .. ')',
      items = items,
      preview = false,
      on_select = function(item)
        -- Insert sample name at cursor
        vim.api.nvim_put({ item.name }, 'c', true, true)
      end,
    })
  end)
end

---Browse saved patterns
function M.patterns()
  local plugin_root = utils.get_plugin_root()
  local samples_dir = plugin_root .. '/samples'

  -- Find .strudel files
  local files = vim.fn.globpath(samples_dir, '*.strudel', false, true)

  local items = {}
  for _, file in ipairs(files) do
    local name = vim.fn.fnamemodify(file, ':t:r')
    table.insert(items, { name = name, file = file, text = name })
  end

  if #items == 0 then
    utils.warn('No patterns found in ' .. samples_dir)
    return
  end

  M.pick({
    title = 'Strudel Patterns',
    items = items,
    on_select = function(item)
      vim.cmd.edit(item.file)
    end,
  })
end

---Browse synth sounds (sine, saw, square, etc.)
function M.sounds()
  local client = require('strudel.client')

  if not client.is_connected() then
    utils.error('Not connected to server. Run :StrudelConnect first')
    return
  end

  client.get_sounds(function(sound_names)
    if #sound_names == 0 then
      utils.warn('No synth sounds available')
      return
    end

    local items = {}
    for _, name in ipairs(sound_names) do
      table.insert(items, { name = name, text = name })
    end

    M.pick({
      title = 'Strudel Synth Sounds (' .. #items .. ')',
      items = items,
      preview = false,
      on_select = function(item)
        -- Insert sound name at cursor
        vim.api.nvim_put({ item.name }, 'c', true, true)
      end,
    })
  end)
end

---Browse sample banks (for .bank())
function M.banks()
  local client = require('strudel.client')

  if not client.is_connected() then
    utils.error('Not connected to server. Run :StrudelConnect first')
    return
  end

  client.get_banks(function(bank_names)
    if #bank_names == 0 then
      utils.warn('No sample banks loaded on server')
      return
    end

    local items = {}
    for _, name in ipairs(bank_names) do
      table.insert(items, { name = name, text = name })
    end

    M.pick({
      title = 'Strudel Sample Banks (' .. #items .. ')',
      items = items,
      preview = false,
      on_select = function(item)
        -- Insert bank name at cursor (for use with .bank())
        vim.api.nvim_put({ item.name }, 'c', true, true)
      end,
    })
  end)
end

return M
