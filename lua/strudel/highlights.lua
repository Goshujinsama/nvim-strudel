local M = {}

---Define the default highlight groups for Strudel
---Uses `default = true` so users and colorschemes can override
---Links to existing semantic highlight groups where possible
function M.setup()
  -- Active element - currently producing sound
  -- Links to Search for high visibility (typically reversed/bright)
  vim.api.nvim_set_hl(0, 'StrudelActive', {
    default = true,
    link = 'Search',
  })

  -- Pending element - about to produce sound
  -- Links to Visual for a subtle "selected" appearance
  vim.api.nvim_set_hl(0, 'StrudelPending', {
    default = true,
    link = 'Visual',
  })

  -- Muted element - inactive/muted
  -- Links to Comment for dimmed appearance
  vim.api.nvim_set_hl(0, 'StrudelMuted', {
    default = true,
    link = 'Comment',
  })

  -- Playhead indicator
  -- Links to WarningMsg for attention-grabbing color
  vim.api.nvim_set_hl(0, 'StrudelPlayhead', {
    default = true,
    link = 'WarningMsg',
  })

  -- Connection status indicators
  vim.api.nvim_set_hl(0, 'StrudelConnected', {
    default = true,
    link = 'DiagnosticOk',
  })

  vim.api.nvim_set_hl(0, 'StrudelDisconnected', {
    default = true,
    link = 'DiagnosticError',
  })

  -- Error highlight
  vim.api.nvim_set_hl(0, 'StrudelError', {
    default = true,
    link = 'DiagnosticUnderlineError',
  })
end

return M
