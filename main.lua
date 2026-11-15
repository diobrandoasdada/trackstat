-- Anime Adventures tracker. Server tự điền địa chỉ web vào biến SERVER.
local S = getgenv().Track_Settings or getgenv().Hermanos_Settings or {}
local RUN_ID = tick()
getgenv().__TRK_RUN = RUN_ID -- chạy lại script sẽ thay thế vòng lặp cũ

local SERVER = "%%SERVER_URL%%"
local function log(...) print("[TRACK]", ...) end
if SERVER:sub(1, 2) == "%%" then
    return warn("[TRACK] Sai cách chạy: phải chạy bằng loadstring(game:HttpGet('https://domain/main.lua')), không dán trực tiếp file main.lua.")
end
if not S.key or S.key == "" or S.key == "KEY_CỦA_BẠN" then
    return warn("[TRACK] Chưa đặt key. Đặt getgenv().Track_Settings = {key=..., PC=...} TRƯỚC dòng loadstring.")
end
local Http = game:GetService("HttpService")
local Players = game:GetService("Players")
repeat task.wait() until game:IsLoaded() and Players.LocalPlayer
local lp = Players.LocalPlayer
local req = (syn and syn.request) or http_request or request or (fluxus and fluxus.request)

if queue_on_teleport then -- giữ script chạy khi về sảnh / vào trận
    pcall(queue_on_teleport, ([[getgenv().Track_Settings={key=%q,PC=%q} loadstring(game:HttpGet(%q))()]])
        :format(tostring(S.key), tostring(S.PC), SERVER .. "/main.lua"))
end

-- Bảng dữ liệu người chơi nằm trong bộ nhớ client (có inventory, gem_amount, player_xp...)
local profile
local function valid(t)
    return type(t) == "table" and rawget(t, "gem_amount") ~= nil and type(rawget(t, "inventory")) == "table"
end
local function findProfile()
    if valid(profile) then return profile end
    profile = nil
    if filtergc then
        local ok, t = pcall(filtergc, "table", { Keys = { "inventory", "level_data", "player_xp" } }, true)
        if ok and valid(t) then profile = t end
    elseif getgc then
        for i, t in ipairs(getgc(true)) do
            if i % 4000 == 0 then task.wait() end
            if type(t) == "table" and valid(t) and rawget(t, "level_data") then profile = t break end
        end
    end
    return profile
end

local function scan()
    local flat, items = {}, {}
    -- 1) Tiền tệ trong lp._stats (có Summer Pearls)
    local st = lp:FindFirstChild("_stats")
    if st then
        for _, c in ipairs(st:GetChildren()) do
            if c:IsA("ValueBase") and type(c.Value) ~= "table" and typeof(c.Value) ~= "Instance" then
                local v = c.Value
                if type(v) == "number" or type(v) == "string" or type(v) == "boolean" then flat["_stats." .. c.Name] = v end
            end
        end
    end
    -- 2) Profile: số dư, token, inventory
    local p = findProfile()
    if p then
        for k, v in pairs(p) do
            if type(v) == "number" or type(v) == "boolean" then flat["Profile." .. tostring(k)] = v end
        end
        local inv = p.inventory
        if inv then
            for k, v in pairs(inv.normal_items or {}) do
                if type(v) == "number" then items[tostring(k)] = v end
            end
            local u = 0
            for _ in pairs(inv.unique_items or {}) do u += 1 end
            flat["Profile.unique_items_count"] = u
            flat["Profile.inventory_capacity"] = inv.capacity
        end
        -- Level tài khoản: dùng đúng hàm game dùng
        if filtergc and st and st:FindFirstChild("player_xp") then
            local ok, f = pcall(filtergc, "function", { Name = "calculate_level" }, true)
            if ok and f then
                local ok2, lv = pcall(f, lp, st.player_xp.Value)
                if ok2 and type(lv) == "number" then flat["Profile.Level"] = lv end
            end
        end
    end
    return flat, items
end

local function send()
    local flat, items = scan()
    local ok, res = pcall(req, {
        Url = SERVER .. "/api/report", Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = Http:JSONEncode({ key = S.key, pc = S.PC, user = lp.Name, userId = lp.UserId,
            place = game.PlaceId, flat = flat, items = items }),
    })
    if not ok then log("Lỗi gửi:", res) return false end
    log("HTTP", res.StatusCode, res.Body and res.Body:sub(1, 80) or "", "| giá trị:", (function() local n = 0 for _ in pairs(flat) do n += 1 end return n end)(), "| item:", (function() local n = 0 for _ in pairs(items) do n += 1 end return n end)())
    return res.StatusCode == 200
end

task.spawn(function()
    while getgenv().__TRK_RUN == RUN_ID do
        pcall(send) -- đang teleport / mất mạng thì bỏ qua, vòng sau gửi lại
        task.wait(30)
    end
end)
