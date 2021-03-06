'use strict';

/* global JuttleAdapterAPI */
let StaticFilterCompiler = JuttleAdapterAPI.compiler.StaticFilterCompiler;

const BINARY_OPS_TO_SQL_OPS = {
    '==':  '=',
    '!=':  '<>',
    '=~':  'LIKE',
    '!~':  'NOT LIKE',
    'OR': 'orWhere',
    'AND': 'andWhere'
};

class FilterSQLCompiler extends StaticFilterCompiler {

    constructor(options) {
        super(options);
        this.baseQuery = options.baseQuery;
    }

    compile(node) {
        return this.visit(node, this.baseQuery);
    }

    visitBinaryExpression(node, sql_query) {
        let self = this;
        let SQL_OP = BINARY_OPS_TO_SQL_OPS[node.operator] || node.operator;

        if (SQL_OP === 'andWhere' || SQL_OP === 'orWhere') {
            return sql_query.where(function() {
                return self.visit(node.left, this)[SQL_OP](function() {
                    return self.visit(node.right, this);
                });
            });
        }

        if (/LIKE/.test(SQL_OP) && node.right.type === 'StringLiteral') {
            node.right.value = node.right.value.replace(/\*/g, '%').replace(/\?/g, '_');
        }

        return sql_query.where(this.visit(node.left), SQL_OP, this.visit(node.right));
    }

    visitUnaryExpression(node, sql_query) {
        var self = this;

        switch (node.operator) {
            case 'NOT':
                return sql_query.whereNot(function() {
                    return self.visit(node.argument, this);
                });
            default:
                this.featureNotSupported(node, node.operator);
        }
    }

    visitField(node) {
        return node.name;
    }

    visitStringLiteral(node) {
        return String(node.value);
    }

    visitArrayLiteral(node) {
        let self = this;
        return node.elements.map(function(e) {
            return self.visit(e);
        });
    }

    visitMomentLiteral(node) {
        return new Date(node.value);
    }

    visitNullLiteral(node) {
        return null;
    }

    visitBooleanLiteral(node) {
        return node.value;
    }

    visitNumberLiteral(node) {
        return node.value;
    }
}

module.exports = FilterSQLCompiler;
