# SIX SHOWDOWN

Game trắc nghiệm sân khấu dành cho 6 đội. Frontend dùng React/Vite, backend dùng Node.js/Express. Nội dung ban đầu có 6 chủ đề, mỗi chủ đề 8 câu trắc nghiệm 4 lựa chọn (48 câu); bộ câu hỏi lấy từ tài liệu người dùng gửi. Điểm số được lưu vào MySQL khi cấu hình Aiven; backend dùng bộ nhớ trong lúc chạy thử nếu chưa có cấu hình cơ sở dữ liệu.

## Chạy trên máy

1. Cài Node.js 20 trở lên.
2. Chạy `npm install` ở thư mục gốc.
3. Chạy `npm run install:all` để cài các gói của frontend và backend.
4. Sao chép `backend/.env.example` thành `backend/.env`, rồi điền cấu hình MySQL Aiven. Có thể bỏ qua bước này để dùng chế độ demo trong bộ nhớ.
5. Chạy `npm run dev`; giao diện mở tại `http://localhost:5173`, API tại `http://localhost:4000`.

Để thử bằng nhiều điện thoại cùng Wi-Fi, mở giao diện bằng địa chỉ LAN của máy chạy game (ví dụ `http://192.168.1.20:5173`) và đặt `CORS_ORIGIN` trong `backend/.env` thành đúng origin đó (ví dụ `http://192.168.1.20:5173`). Các thiết bị tự gọi cùng backend qua địa chỉ LAN này. Ở chế độ demo, các thiết bị vẫn đồng bộ khi cùng nối vào một tiến trình backend; dữ liệu demo sẽ mất nếu backend khởi động lại. Khi deploy, mọi thiết bị cần mở cùng frontend Vercel và frontend cần trỏ `VITE_API_URL` tới cùng backend Render.

## Vai trò chủ trì và người chơi

- Chủ trì đăng nhập bằng tài khoản `admin`, mật khẩu mặc định `12345`. Chủ trì tạo game, chọn chủ đề và mở câu đầu tiên; chủ trì cũng được sửa câu hỏi và gắn âm thanh.
- Người chơi không cần tài khoản quản trị. Mỗi người tự nhập tên rồi chọn nhóm 1, 2, 3, 4, 5 hoặc 7 để vào đội; phiên đăng ký gắn với thiết bị đó và chỉ nhóm đã chọn được bấm chuông. Trước khi chủ trì mở câu đầu tiên, người chơi có thể rời nhóm nếu đăng ký nhầm rồi chọn lại. Thành viên đội đang chơi có thể chọn đáp án và chọn ô câu tiếp theo; đội thắng chủ đề chọn chủ đề kế tiếp.
- Chủ trì và các điện thoại nhận cập nhật trực tiếp từ backend qua luồng sự kiện; polling 3 giây/lần làm đường dự phòng. Trạng thái tải hiển thị riêng trên từng máy, còn backend xác nhận lượt và phiên bản trạng thái để các máy hội tụ về cùng kết quả.
- Quyền chủ trì được kiểm tra ở backend. Phiên đăng nhập tồn tại tối đa 12 giờ hoặc đến khi backend khởi động lại. Có thể cấu hình `ADMIN_USERNAME` và `ADMIN_PASSWORD` trong biến môi trường backend.

## MySQL trên Aiven

Trong trang quản lý Aiven, tạo dịch vụ MySQL và cơ sở dữ liệu. Đưa các giá trị host, port, database, user, password vào biến môi trường của backend. Bật TLS bằng `DB_SSL=true` và dán nội dung CA certificate vào `DB_SSL_CA` (hoặc đặt đường dẫn file trong `DB_SSL_CA_FILE`). Backend tạo các bảng `games`, `scores`, `score_events` khi khởi động. Khi một chủ đề kết thúc, điểm các câu trả lời đúng được cộng cho đội nhận thưởng và lưu thành một sự kiện điểm trong cùng giao dịch khóa hàng.

Không commit thông tin kết nối vào Git. Khi `DATABASE_URL` hoặc đủ các biến `DB_*` được đặt, backend yêu cầu kết nối MySQL thành công thay vì tự chuyển sang dữ liệu demo.

## Deploy

### Vercel (frontend)

- Import repository và đặt **Root Directory** là `frontend`.
- Build command: `npm run build`; output directory: `dist`.
- Đặt `VITE_API_URL` thành URL HTTPS của web service Render, ví dụ `https://six-showdown-api.onrender.com`.
- Sau deploy, ghi lại domain Vercel để cấu hình `CORS_ORIGIN` ở backend Render.

### Render (backend)

- Tạo Web Service từ repository, đặt **Root Directory** là `backend`.
- Build command: `npm install`; Start command: `npm start`.
- Không cần đặt biến `DB_*` hoặc `DATABASE_URL` nếu chơi một lần; backend tự dùng bộ nhớ. Game và điểm sẽ mất khi backend khởi động lại.
- Đặt `CORS_ORIGIN` thành domain frontend Vercel, ví dụ `https://six-showdown.vercel.app` (không thêm dấu `/` cuối). Có thể thêm nhiều origin, phân cách bằng dấu phẩy.
- Đăng nhập chủ trì mặc định là `admin` / `12345`; có thể đặt `ADMIN_USERNAME` và `ADMIN_PASSWORD` trong biến môi trường Render.
- File âm thanh tải lên nằm trong `backend/uploads`; ổ đĩa dịch vụ có thể bị xóa khi deploy. Nếu cần giữ âm thanh, cấu hình persistent disk trên Render và đặt `UPLOAD_DIR` thành đường dẫn mount.

Render Free có thể đưa dịch vụ vào trạng thái ngủ; lần gọi đầu sau khi ngủ có thể mất thêm thời gian. Aiven credentials và domain cụ thể cần được cung cấp trong phần biến môi trường triển khai, không nhúng vào mã nguồn.

## Luật trong ứng dụng

- Tạo game mới có 6 chủ đề; mỗi chủ đề là một màn chơi gồm 8 ô câu hỏi trắc nghiệm, mỗi câu có 4 lựa chọn. Bảng ô có phong cách xanh và viền vàng giống bảng Family Feud. Có thể sửa câu hỏi, lựa chọn, đáp án đúng và điểm trước khi mở câu đầu tiên.
- Chủ trì mở một ô để bắt đầu chủ đề đầu tiên. Mỗi chủ đề mới sau đó cũng mở đầu bằng một câu giành chuông cho cả 6 đội, kể cả đội vừa nhận điểm ở chủ đề trước; chủ trì mở ô đầu tiên và đội giành chuông trả lời đúng sẽ chơi chủ đề đó. Đội thắng chủ đề chọn chủ đề kế tiếp.
- Cần ghép ít nhất một người vào đủ 6 đội trước khi mở câu đầu tiên; mỗi đội nhận tối đa 6 người.
- Ở câu mở đầu mỗi chủ đề, các đội có 15 giây đọc câu rồi tranh chuông. Đội được máy chủ ghi nhận trước nhận lượt trả lời; nếu trả lời sai hoặc hết giờ, các đội còn lại tiếp tục tranh chuông trên câu đó. Đội trả lời đúng giành quyền chơi chủ đề.
- Trong màn chủ đề, một thành viên của đội đang chơi chọn một đáp án; đáp án bị khóa ngay khi gửi. Đội đó chọn ô tiếp theo. Câu sai hoặc hết giờ tính một lỗi liên tiếp, còn câu đúng xóa chuỗi lỗi. Chỉ sau 2 lỗi liên tiếp thì các đội khác mới được tranh chuông để có một lượt cướp trên câu hỏi đó. Nếu đội cướp trả lời đúng, đội cướp nhận điểm các câu đã đúng trước đó cộng điểm của câu cướp; nếu trả lời sai hoặc hết giờ, đội đang chơi nhận điểm từ các câu đã trả lời đúng trước đó. Chủ đề kết thúc ngay trong cả hai trường hợp.
- Mỗi câu đúng đóng góp số điểm ghi trên ô vào phần thưởng cuối chủ đề (mặc định 100 điểm/câu, tối đa 800 điểm). Vì vậy, đội chơi đúng 5 câu rồi thua lượt cướp nhận 500 điểm; nếu đội cướp trả lời đúng câu tiếp theo thì nhận 600 điểm. Đội trả lời đúng cả 8 câu nhận đủ 800 điểm. Điểm được cộng một lần khi chủ đề kết thúc và lưu vào `scores` cùng một sự kiện trong `score_events` của MySQL.
- Sau khi chủ đề kết thúc, đội thắng chọn một chủ đề chưa chơi. Các chủ đề đã kết thúc bị khóa.
- Mỗi người chơi tự nhập tên rồi đăng ký vào một nhóm: 1, 2, 3, 4, 5 hoặc 7 (không có nhóm 6). Nhóm được chọn chính là đội người chơi tham gia; mỗi nhóm nhận tối đa 6 thành viên.
- Tải lên hiệu ứng cho chuông, trả lời đúng, trả lời sai và mở câu hỏi. Hiệu ứng phát tại trình duyệt đang chạy game.
