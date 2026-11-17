--[[
================================================================================
  TrackStat v2 — Anime Adventures account tracker
================================================================================
  Dùng đúng cách (giữ nguyên loader cũ):

    getgenv().Track_Settings = {
      ['key'] = '3409a8e2-20b1-4daa-9c9d-4f41a8f5159b',
      ['PC']  = 'MAY-1',
    }
    task.spawn(function() loadstring(game:HttpGet('https://raw.githubusercontent.com/diobrandoasdada/trackstat/main/main.lua'))() end)

  File chạy được CẢ HAI cách:
    - loadstring(game:HttpGet('https://raw.githubusercontent.com/.../main.lua'))()
      → tự dùng server mặc định https://trackstat-xzvf.onrender.com
    - loadstring(game:HttpGet('https://trackstat-xzvf.onrender.com/main.lua'))()
      → server tự điền URL công khai vào %%SERVER_URL%%
  Có thể override bằng getgenv().Track_Settings.server = 'https://...' nếu cần.

  Lệnh hỗ trợ trong console executor:
    getgenv().TRACK_NOW()      -- gửi ngay một lần
    getgenv().TRACK_STATUS()   -- in trạng thái quét / lỗi gần nhất
    getgenv().TRACK_RESET()    -- xoá cache local (khi muốn quét lại từ đầu)
================================================================================
]]

local S = getgenv().Track_Settings or getgenv().Hermanos_Settings or {}

-- Trạng thái sống qua các lần reload / teleport.
local ST = getgenv().__TRK_STATE
if type(ST) ~= 'table' then
  ST = {}
  getgenv().__TRK_STATE = ST
end
ST.flat = ST.flat or {}
ST.items = ST.items or {}
ST.strikes = ST.strikes or {}
ST.lastGood = ST.lastGood or {}
ST.failCount = ST.failCount or 0

local RUN_ID = tick()
getgenv().__TRK_RUN = RUN_ID

-- Khi upload trực tiếp lên GitHub, %%SERVER_URL%% không được thay thế → dùng URL mặc định.
-- Khi tải qua /main.lua, server đã điền sẵn URL công khai vào biến này.
local DEFAULT_SERVER = 'https://trackstat-xzvf.onrender.com'
local SERVER = tostring(S.server or S.url or '%%SERVER_URL%%')
SERVER = SERVER:gsub('%s+', ''):gsub('/+$', '')
if SERVER:sub(1, 2) == '%%' or SERVER == '' then SERVER = DEFAULT_SERVER end

if not S.key or S.key == '' or S.key == 'KEY_CỦA_BẠN' then
  return warn('[TRACK] Chưa đặt key. Đặt getgenv().Track_Settings = {key=..., PC=...} TRƯỚC dòng loadstring.')
end

local PC = tostring(S.PC or S.pc or 'NO-PC')
if PC == '' then PC = 'NO-PC' end

local Http = game:GetService('HttpService')
local Players = game:GetService('Players')
repeat task.wait() until game:IsLoaded() and Players.LocalPlayer

local lp = Players.LocalPlayer
local req = (syn and syn.request) or http_request or request or (fluxus and fluxus.request)
if type(req) ~= 'function' then
  return warn('[TRACK] Executor không hỗ trợ HTTP request. Hãy dùng Delta/Wave/AWP/Swift/Solara.')
end

local function log(...)
  local parts = {}
  for i = 1, select('#', ...) do parts[#parts + 1] = tostring(select(i, ...)) end
  print('[TRACK] ' .. table.concat(parts, ' '))
end

local function warnLog(...)
  local parts = {}
  for i = 1, select('#', ...) do parts[#parts + 1] = tostring(select(i, ...)) end
  warn('[TRACK] ' .. table.concat(parts, ' '))
end

local function goodNum(v)
  return type(v) == 'number' and v == v and v ~= math.huge and v ~= -math.huge
end

local function goodLevel(v)
  return goodNum(v) and v >= 1 and v <= 5000
end

--==============================================================================
-- TÌM PROFILE ĐÚNG CỦA NGƯỜI CHƠI
--==============================================================================

local function profileScore(t)
  if type(t) ~= 'table' then return -1 end
  if type(rawget(t, 'inventory')) ~= 'table' then return -1 end
  if rawget(t, 'gem_amount') == nil then return -1 end

  local score = 10
  local uid = rawget(t, 'user_id') or rawget(t, 'userId') or rawget(t, 'User_id') or rawget(t, 'UserId')
  if uid ~= nil and tostring(uid) == tostring(lp.UserId) then score = score + 1000 end

  local nm = rawget(t, 'name') or rawget(t, 'username') or rawget(t, 'player_name') or rawget(t, 'playerName')
  if nm and tostring(nm) == lp.Name then score = score + 500 end

  if rawget(t, 'level_data') ~= nil then score = score + 120 end
  if rawget(t, 'player_xp') ~= nil then score = score + 80 end

  local inv = rawget(t, 'inventory')
  local normal = inv.normal_items
  if type(normal) == 'table' then
    local n = 0
    for _ in pairs(normal) do n = n + 1 end
    score = score + math.min(n, 200)
  end
  return score
end

local function findProfile()
  local cached = ST.profile
  if profileScore(cached) >= 0 and (ST.profileScore or 0) >= 900 then
    return cached
  end

  local best, bestScore = nil, -1

  if type(filtergc) == 'function' then
    local patterns = {
      { Keys = { 'inventory', 'gem_amount' } },
      { Keys = { 'inventory', 'level_data', 'player_xp' } },
      { Keys = { 'inventory', 'gem_amount', 'player_xp' } },
    }
    for _, pat in ipairs(patterns) do
      local ok, found = pcall(filtergc, 'table', pat, true)
      if ok then
        local sc = profileScore(found)
        if sc > bestScore then best, bestScore = found, sc end
      end
    end
  end

  if bestScore < 900 and type(getgc) == 'function' then
    local ok, list = pcall(getgc, true)
    if ok and type(list) == 'table' then
      for i, value in ipairs(list) do
        if i % 1500 == 0 then task.wait() end
        local sc = profileScore(value)
        if sc > bestScore then best, bestScore = value, sc end
        if bestScore >= 1100 then break end
      end
    end
  end

  if best then
    ST.profile, ST.profileScore = best, bestScore
  end
  return best
end

--==============================================================================
-- LEVEL — ưu tiên field trực tiếp, sau đó hàm calculate_level, có sanity check
--==============================================================================

local function median(list)
  local n = #list
  if n == 0 then return nil end
  table.sort(list)
  if n % 2 == 1 then return list[(n + 1) / 2] end
  return (list[n / 2] + list[n / 2 + 1]) / 2
end

local function collectLevelFunctions()
  local out = {}
  if type(filtergc) == 'function' then
    local ok, fn = pcall(filtergc, 'function', { Name = 'calculate_level' }, true)
    if ok and type(fn) == 'function' then out[#out + 1] = fn end
  end
  if type(getgc) == 'function' and #out < 6 then
    local ok, list = pcall(getgc, true)
    if ok and type(list) == 'table' then
      for i, fn in ipairs(list) do
        if type(fn) == 'function' and #out < 6 then
          local okInfo, info = pcall(function() return debug.getinfo(fn) end)
          if okInfo and type(info) == 'table' then
            local src = tostring(info.source or ''):lower()
            if src:find('level') then out[#out + 1] = fn end
          end
        end
        if i % 2000 == 0 then task.wait() end
      end
    end
  end
  return out
end

local function readLevel(profile, statsFolder)
  local direct = {}
  local function addDirect(v)
    if goodLevel(v) then direct[#direct + 1] = v end
  end

  if profile then
    local ld = rawget(profile, 'level_data')
    if type(ld) == 'table' then
      addDirect(tonumber(rawget(ld, 'level')))
      addDirect(tonumber(rawget(ld, 'current_level')))
      addDirect(tonumber(rawget(ld, 'account_level')))
    end
    addDirect(tonumber(rawget(profile, 'level')))
    addDirect(tonumber(rawget(profile, 'player_level')))
    addDirect(tonumber(rawget(profile, 'account_level')))
  end

  if statsFolder then
    local node = statsFolder:FindFirstChild('level')
    if node then addDirect(tonumber(node.Value)) end
  end

  if #direct > 0 then
    table.sort(direct)
    local value = direct[#direct]
    ST.lastGood.level = value
    return value
  end

  local xp = nil
  if profile then
    xp = tonumber(rawget(profile, 'player_xp'))
    if not xp then
      local ld = rawget(profile, 'level_data')
      if type(ld) == 'table' then
        xp = tonumber(rawget(ld, 'xp')) or tonumber(rawget(ld, 'experience'))
      end
    end
  end
  if not xp and statsFolder then
    local node = statsFolder:FindFirstChild('player_xp')
    if node then xp = tonumber(node.Value) end
  end

  if xp then
    if not ST.levelFns then ST.levelFns = collectLevelFunctions() end
    local results = {}
    for _, fn in ipairs(ST.levelFns) do
      local ok, value = pcall(fn, lp, xp)
      if not ok or not goodLevel(value) then
        ok, value = pcall(fn, xp)
      end
      if ok and goodLevel(value) then results[#results + 1] = value end
    end
    if #results > 0 then
      local value = median(results)
      if goodLevel(value) then
        ST.lastGood.level = value
        return value
      end
    end
  end

  return ST.lastGood.level
end

--==============================================================================
-- QUÉT DỮ LIỆU
--==============================================================================

-- Ghi một giá trị vào flat, chặn số 0 thoáng qua (thường xảy ra lúc teleport).
local function put(out, key, value)
  if value == nil then return end
  key = tostring(key):sub(1, 120)
  if key == '' then return end

  if type(value) == 'number' then
    if not goodNum(value) or value < 0 then return end
    local prev = ST.flat[key]
    if value == 0 and type(prev) == 'number' and prev > 0 then
      local strikes = (ST.strikes[key] or 0) + 1
      ST.strikes[key] = strikes
      if strikes < 3 then return end -- giữ bản cuối cùng tốt
    else
      ST.strikes[key] = 0
    end
  elseif type(value) == 'string' then
    value = value:sub(1, 200)
    if value == '' then return end
  elseif type(value) ~= 'boolean' then
    return
  end

  out[key] = value
  ST.flat[key] = value
end

local function scanFlat()
  local statsFolder = lp:FindFirstChild('_stats')

  if statsFolder then
    for _, child in ipairs(statsFolder:GetChildren()) do
      local ok, value = pcall(function() return child.Value end)
      if ok then put(ST.flat, '_stats.' .. child.Name, value) end
    end
  end

  local profile = findProfile()
  if profile then
    for key, value in pairs(profile) do
      if type(key) == 'string' then
        local kind = type(value)
        if kind == 'number' or kind == 'boolean' or kind == 'string' then
          put(ST.flat, 'Profile.' .. key, value)
        end
      end
    end

    local inv = rawget(profile, 'inventory')
    if type(inv) == 'table' then
      local normal = inv.normal_items
      if type(normal) == 'table' then
        local n = 0
        for _ in pairs(normal) do n = n + 1 end
        put(ST.flat, 'Profile.inventory_items', n)
      end
      local unique = inv.unique_items
      if type(unique) == 'table' then
        local n = 0
        for _ in pairs(unique) do n = n + 1 end
        put(ST.flat, 'Profile.unique_items_count', n)
      end
      put(ST.flat, 'Profile.inventory_capacity', tonumber(inv.capacity))
    end
  end

  put(ST.flat, 'Profile.Level', readLevel(profile, statsFolder))
  put(ST.flat, 'Meta.place', game.PlaceId)
  put(ST.flat, 'Meta.timestamp', tick())

  local out = {}
  for key, value in pairs(ST.flat) do out[key] = value end
  return out, profile
end

local function scanItems(profile)
  local items = {}
  if type(profile) ~= 'table' then return items end
  local inv = rawget(profile, 'inventory')
  if type(inv) ~= 'table' then return items end
  local normal = inv.normal_items
  if type(normal) ~= 'table' then return items end

  for key, value in pairs(normal) do
    local n = tonumber(value)
    if goodNum(n) and n > 0 then
      local id = tostring(key)
      items[id] = n
      ST.items[id] = n
      ST.strikes['Item.' .. id] = 0
    end
  end
  return items
end

local function detectContext()
  local place = tonumber(game.PlaceId) or 0
  if place ~= 8304191830 then return 'match' end
  if workspace:FindFirstChild('_MAP_CONFIG') ~= nil then return 'match' end
  return 'lobby'
end

--==============================================================================
-- GỬI DỮ LIỆU
--==============================================================================

local warnedKey = false

local function send()
  local flat, profile = scanFlat()
  local freshItems = scanItems(profile)
  local context = detectContext()

  -- Trong trận không gửi item (game thường trả inventory rỗng). Server giữ bản cũ.
  local sendItems = nil
  if context == 'lobby' and next(freshItems) ~= nil then
    sendItems = freshItems
  elseif next(ST.items) == nil and next(freshItems) ~= nil then
    sendItems = freshItems
  elseif ST.needFull and next(ST.items) ~= nil then
    sendItems = ST.items
  end

  local payload = {
    key = tostring(S.key),
    pc = PC,
    user = lp.Name,
    userId = lp.UserId,
    place = game.PlaceId,
    flat = flat,
    items = sendItems,
    meta = { context = context, ts = tick(), version = 2, client = 'TrackStat/2.0' },
  }

  local okEncode, body = pcall(function() return Http:JSONEncode(payload) end)
  if not okEncode then
    warnLog('Không encode được JSON:', body)
    return false
  end

  local okReq, res = pcall(req, {
    Url = SERVER .. '/api/report',
    Method = 'POST',
    Headers = { ['Content-Type'] = 'application/json' },
    Body = body,
  })
  if not okReq or not res then
    warnLog('Lỗi gửi:', res)
    return false
  end

  local status = tonumber(res.StatusCode) or 0
  if status < 200 or status >= 300 then
    local preview = tostring(res.Body or ''):sub(1, 140)
    if (status == 401 or status == 403) and not warnedKey then
      warnedKey = true
      warnLog('Sai key (HTTP ' .. status .. '). Lấy key mới trong cửa sổ server / Render logs rồi sửa Track_Settings.key.')
    end
    warnLog('HTTP ' .. status .. ': ' .. preview)
    return false
  end

  warnedKey = false
  local parsed = nil
  pcall(function() parsed = Http:JSONDecode(tostring(res.Body or '')) end)
  ST.needFull = false
  if type(parsed) == 'table' then
    ST.needFull = parsed.needFull == true
  end

  local flatCount = 0
  for _ in pairs(flat) do flatCount = flatCount + 1 end
  local itemCount = 0
  for _ in pairs(ST.items) do itemCount = itemCount + 1 end
  log(
    'HTTP ' .. status ..
    ' | Lv ' .. tostring(flat['Profile.Level'] or '?') ..
    ' | gems ' .. tostring(flat['Profile.gem_amount'] or flat['_stats.gem_amount'] or '?') ..
    ' | flat ' .. flatCount ..
    ' | items ' .. itemCount ..
    ' | ' .. context
  )
  return true
end

-- Giữ script chạy qua teleport.
if queue_on_teleport then
  local code = ([[getgenv().Track_Settings={key=%q,PC=%q,server=%q} loadstring(game:HttpGet(%q))()]])
    :format(tostring(S.key), PC, SERVER, SERVER .. '/main.lua')
  pcall(queue_on_teleport, code)
end

getgenv().TRACK_NOW = function()
  local ok, result = pcall(send)
  if not ok then warnLog('Lỗi TRACK_NOW:', result) return false end
  return result
end
getgenv().TRACK_STATUS = function()
  log('server=', SERVER, '| PC=', PC, '| fail=', ST.failCount, '| needFull=', tostring(ST.needFull))
  log('cache: flat=', (function() local n = 0 for _ in pairs(ST.flat) do n = n + 1 end return n end)(),
      'items=', (function() local n = 0 for _ in pairs(ST.items) do n = n + 1 end return n end)())
end
getgenv().TRACK_RESET = function()
  ST.flat, ST.items, ST.strikes, ST.lastGood = {}, {}, {}, {}
  ST.profile, ST.profileScore, ST.levelFns, ST.needFull = nil, nil, nil, false
  log('Đã xoá cache local.')
end

log('TrackStat v2 đã nạp · server=' .. SERVER .. ' · PC=' .. PC .. ' · key=' .. (S.key ~= '' and 'có' or 'không'))

task.spawn(function()
  while getgenv().__TRK_RUN == RUN_ID do
    local sent, ok = pcall(send)
    if not sent then
      warnLog('Lỗi khi quét/gửi:', ok)
      ok = false
    end
    local waitSec = 30
    if not ok then
      ST.failCount = math.min((ST.failCount or 0) + 1, 4)
      waitSec = math.min(30 * (2 ^ ST.failCount), 300)
    else
      ST.failCount = 0
    end

    local waited = 0
    while waited < waitSec and getgenv().__TRK_RUN == RUN_ID do
      task.wait(1)
      waited = waited + 1
    end
  end
end)
