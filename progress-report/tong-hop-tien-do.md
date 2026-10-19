# Tổng hợp tiến độ và đánh giá đồ án Courtly

## Thông tin báo cáo

Đề tài: Xây dựng website quản lý đặt chỗ và sử dụng sân thể thao. Sinh viên: Kiều Văn Hải, MSSV 170123486, lớp DX23TT11. Giảng viên hướng dẫn: Trầm Hoàng Nam. Kỳ kế hoạch: 07/09–18/10/2026. Ngày tổng hợp: 19/10/2026.

Courtly được tài liệu mô tả là website đã hiện thực các nhóm chức năng đặt sân và vận hành, có triển khai trên Render với PostgreSQL tại Aiven. Việc kiểm chứng còn giới hạn; các kết quả dưới đây giữ theo đợt kiểm tra trong báo cáo đồ án.

## Tiến độ theo ba giai đoạn

| Giai đoạn | Tuần | Công việc theo kế hoạch | Sản phẩm đối chiếu trong tài liệu |
| --- | --- | --- | --- |
| Nghiên cứu lý thuyết | 1–2 | Tìm hiểu bài toán, lý thuyết và chọn giải pháp | Tổng quan, phạm vi, tiêu chí; mô hình web, API, giao dịch, phân quyền, Socket.IO |
| Nghiên cứu chuyên sâu | 3–4 | Thiết kế mô hình/dữ liệu, xây dựng chương trình, đánh giá giải pháp | Use case, vòng đời đặt sân, dữ liệu, API, chức năng vận hành và kiến trúc triển khai |
| Viết báo cáo | 5–6 | Viết đúng mẫu, tổng hợp kết quả, đánh giá và rà soát | Báo cáo năm chương, hình/bảng/sơ đồ, phụ lục, kiểm tra và hướng phát triển |

Mốc tuần bám mục 1.4. Tài liệu không có nhật ký từng tuần nên chưa đủ căn cứ xác nhận mỗi công việc hoàn tất đúng tuần, tính phần trăm hoàn thành hoặc kết luận không có chậm tiến độ.

## Kết quả sản phẩm được báo cáo

- Tài khoản: đăng ký, đăng nhập email/điện thoại, hồ sơ, vai trò người chơi/ca trưởng/chủ sân.
- Lịch và đặt sân: xem lịch công khai, giữ chỗ 5 phút, xác nhận, hủy theo điều kiện; đặt tại quầy, đổi lịch và gia hạn.
- Giá và thu tiền: tính theo ca 30 phút, loại ngày và nhóm thành viên; dịch vụ phát sinh, giảm giá và trạng thái đã thu từng khoản.
- Vận hành: lịch cố định hằng tuần, quyền nhân viên, hạn mức và xét duyệt giảm giá, nhật ký trước/sau thay đổi.
- Triển khai: máy chủ trên Render, PostgreSQL trên Aiven, yêu cầu HTTP định kỳ từ cron-job.org.

Minh chứng: Chương 3, Chương 4, Phụ lục C–F. Website được tài liệu ghi nhận tại https://haikv200699-csn-dx23tt11-kieuvanhai.onrender.com/ trong lần đối chiếu 18/10/2026; bộ báo cáo tiến độ này không thực hiện kiểm tra trực tuyến mới.

## Kết quả kiểm tra được ghi trong đồ án

Phiên bản: `e18bff8`. Môi trường: Windows, Node.js v24.19.0. Đơn vị đếm là tập tin kiểm thử, không phải số ca thử hoặc số phép kiểm tra.

| Chỉ tiêu | Số tệp |
| --- | --- |
| Tổng cộng | 37 |
| Đã chạy ngoại tuyến | 33 |
| Chạy thành công | 32 |
| Dừng do lỗi | 1 |
| Chưa chạy tích hợp | 4 |

Nguồn: mục 4.6, Bảng 4.2 và Phụ lục B. `hero-slider-test.js` dừng tại `classList.toggle` vì DOM mô phỏng thiếu thuộc tính tương ứng. Bốn bài chưa chạy trong đợt này là đặt đồng thời, API giá, SQL giá và phân quyền nhân viên tích hợp. Không chuyển các mục chưa chạy thành kết quả đạt.

Phiên quan sát công khai ngày 18/10/2026 ghi nhận sáu thao tác O01–O06: mở trang chủ, mở đăng nhập, chuyển đăng ký, mở bộ chọn ngày, đọc lịch và đổi sang ngày 19/10/2026. Nguồn: Bảng 4.1.

Mục 4.7 và Bảng 4.3 liệt kê **12 kịch bản T01–T12 cùng kết quả mong đợi**, gồm tài khoản, giới hạn thời gian, đặt đồng thời, hai ca liền kề, giữ chỗ hết hạn, chuyển khoản quá hạn, tính giá, giữ giá cũ, phân quyền, duyệt giảm và gia hạn xung đột. Đây chưa phải 12 kết quả thực nghiệm đã đạt.

## Đánh giá kết quả vận dụng lý thuyết

Theo mục 4.8, mô hình quan hệ và ràng buộc khoảng giúp biểu diễn quy tắc lịch; giao dịch và khóa hàng bảo vệ các thay đổi liên quan; xác thực phiên kết hợp kiểm tra quyền hiện hành giới hạn thao tác. API xử lý nghiệp vụ và Socket.IO thông báo thay đổi. Những cơ chế này cần tiếp tục được kiểm chứng tích hợp trên dữ liệu biệt lập.

## Hạn chế và kế hoạch tiếp tục

| Ưu tiên | Công việc | Minh chứng cần bổ sung |
| --- | --- | --- |
| 1 | Sửa DOM mô phỏng của hero-slider và chạy lại | Log chạy cùng phiên bản mã nguồn |
| 1 | Chạy bốn bài tích hợp trên database thử riêng | Môi trường, mã phản hồi, dữ liệu trước/sau, kết quả từng ca |
| 1 | Rà soát tài liệu trước khi nộp | Trích dẫn, danh mục, số trang và phiên bản tài liệu thống nhất |
| 2 | Đối chiếu tiền thực thu, còn thu và hoàn tiền | Quy tắc nghiệp vụ và bảng đối chiếu hóa đơn |
| 2 | Xác minh TLS Aiven, vận hành tác vụ nền và theo dõi API/database | Cấu hình phù hợp, nhật ký khởi động và kiểm tra có truy cập dữ liệu |
| 3 | Nghiên cứu đối soát thanh toán và mở rộng nghiệp vụ | Thiết kế xử lý thông báo, chống ghi nhận lặp và kiểm thử |

Chưa có đánh giá tải hoặc mức hài lòng người dùng. Xác nhận chuyển khoản hiện còn thủ công; HTTP 200 của trang chủ chỉ cho thấy đường dẫn trả lời yêu cầu. Tác vụ hết hạn vẫn phụ thuộc tiến trình Node.js đang hoạt động.

## Căn cứ tổng hợp

`Bao_cao_Courtly_bam_sat_ke_hoach_va_danh_gia.docx`, ngày 19/10/2026: mục 1.4; Chương 3; mục 4.6–4.9; Chương 5; Phụ lục A–F. Không bổ sung điểm số, nhận xét giảng viên hoặc kết quả thực nghiệm ngoài tài liệu.

[Danh mục báo cáo theo tuần](README.md)
