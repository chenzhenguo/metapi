CREATE TABLE IF NOT EXISTS `route_group_sources` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `group_route_id` INT NOT NULL, `source_route_id` INT NOT NULL, FOREIGN KEY (`group_route_id`) REFERENCES `token_routes`(`id`) ON DELETE CASCADE, FOREIGN KEY (`source_route_id`) REFERENCES `token_routes`(`id`) ON DELETE CASCADE);
ALTER TABLE `token_routes` ADD COLUMN `route_mode` VARCHAR(191) DEFAULT 'pattern';
CREATE UNIQUE INDEX `route_group_sources_group_source_unique` ON `route_group_sources` (`group_route_id`, `source_route_id`);
CREATE INDEX `route_group_sources_source_route_id_idx` ON `route_group_sources` (`source_route_id`);
