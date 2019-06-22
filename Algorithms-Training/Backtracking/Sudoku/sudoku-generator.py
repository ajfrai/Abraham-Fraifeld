#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sun Jun  9 16:55:06 2019

@author: fraifeld-mba
"""

import unittest
import random

### INIT METHODS
def read_board(file):
    board = empty_board()
    with open(file, "r") as f:
        i = 0
        for line in f:
            board[i]=[int(x) for x in line.split()]
            i = i + 1
    return board

def empty_board():
    board = []
    for i in range(9):
        board.append([])
        for j in range(9):
            board[i].append(0)
            
    return board

def initialize_board():
    board = empty_board()
    init_indices = [0,3,6,9] #indices of diagonal matrix corners are 0,0 - 2,2; 3,3 - 5,5; 6-6  - 8,8
    for index in [0,1,2]:
        taken = [] # for each matrix, we have a list of numbers that are already taken
        for i in range(init_indices[index],init_indices[index+1]):
            for j in range(init_indices[index],init_indices[index+1]):
                x = random.randint(1,9)
                while x in taken: # ensure that the number that will e placed in the matrix is not already in it
                    x = random.randint(1,9)
                board[i][j] = x
                taken.append(x)
                
    return board

def initialize_impossible_board():
    board = empty_board()
    board[0] = [1,2,3,4,5,6,7,8,9]
    board[1] = [9,8,7,3,2,1,4,5,6]
    board[2] = [5,4,0,9,8,7,6,3,2]
    return board
    
    

### SUBSET METHODS
def get_3x3(b,number):
    i_start = (number%3)*3
    j_start = int(number/3)*3
    
    mx = []
    for row,i in enumerate(range(i_start,i_start+3)):
        mx.append([])
        for j in range(j_start,j_start+3):
            mx[row].append(b[i][j])
    return mx

def ix_to_3x3(b,i,j):
    i = int(i/3)*3
    j = int(j/3)*3
    mx = []
    for row,x in enumerate(range(i, i + 3)):
        mx.append([])
        for y in range(j, j + 3):
            mx[row].append(b[x][y])

            
    return mx

def get_column(b,j):
    col = []
    for i in range(len(b)):
        col.append(b[i][j])
    return col
        

### VALIDITY METHODS
    
def validRowInsert(b,i,j,value):
    row = b[i]
    return value not in row

def validColumnInsert(b,i,j,value):
    column = [x[j] for x in b]
    return value not in column

def valid3x3Insert(b,i,j,value):
    taken = sum(ix_to_3x3(b,i,j),[])
    return value not in taken

def validInsert(b,i,j,value):
    return (validRowInsert(b,i,j,value) and validColumnInsert(b,i,j,value) and  valid3x3Insert(b,i,j,value))

### Get next empty square method

def next_empty_square(b):
    for i in range(len(b)):
        for j in range(len(b[i])):
            if b[i][j] == 0:
                return [i,j]
    return [-1,-1]

### Insert method
    
def insert(b,i,j,value):
    b[i][j] = value
    return b
    
def reset_value(b,i,j):
    b[i][j] = 0
    return b

### Solver
    
def solve(b):
    i,j = next_empty_square(b)
    if i == -1:
        return [True,b]
    for x in range(1,10):
        if validInsert(b,i,j,x):
            b = insert(b,i,j,x)
            r = solve(b) # if we can solve from this point, return the board
            if r[0]:
                return [True,b]
            # otherwise, reset the value and try with the next value
            b = reset_value(b,i,j)
            
    return [False,b]
            



## Unit tests
class BoardSetUpTestCase(unittest.TestCase):
    def setUp(self):
        self.emptyBoard = empty_board()
        self.initBoard = initialize_board()
        
    def test_initial_board_size(self):
        self.assertEqual(len(self.emptyBoard), 9,
                         'incorrect length')
        self.assertEqual([len(i) for i in self.emptyBoard], [9]*9,
                         'incorrect width')
        
    def test_initial_board_values(self):
        for i in range(9):
            for j in range(9):
                self.assertEqual(self.emptyBoard[i][j],0,"incorrect initial board values")
                
    def test_initial_diagonal_matrix_element_filling(self):
        # check to ensure the initial diagonal matrices are filled
         
         init_indices = [0,3,6,9] #indices of diagonal matrix corners are 0,0 - 2,2; 3,3 - 5,5; 6-6  - 8,8
         for index in [0,1,2]:
             for i in range(init_indices[index],init_indices[index+1]):
                for j in range(init_indices[index],init_indices[index+1]):
                    self.assertEqual(self.initBoard[i][j]==0, False, 'initial filled diagonal matrix contains 0s') 
    
    def test_initial_diagonal_matrix_zero_filling(self):
        # check to ensure the non-initial-diagonal matrix values are 0
        mxs = [get_3x3(self.initBoard, i) for i in [1,2,3,5,6,7]]
        for m in mxs:
            for i in range(len(m)):
                for j in range(len(m)):
                    self.assertEqual(m[i][j],0,'there are filled values outside of the initial diagonal matrices')
                
    
    def test_initial_diagonal_matrix_validity(self): 
        # since the initial diagonal matrices are independent, we only need to check
        # if the elements in each 3x3 matrix are unique. No need to check row or column
        init_indices = [0,3,6,9] #indices of diagonal matrix corners are 0,0 - 2,2; 3,3 - 5,5; 6-6  - 8,8
        for index in [0,1,2]:
            taken = [] # for each matrix, we have a list of numbers that are already taken
            for i in range(init_indices[index],init_indices[index+1]):
                for j in range(init_indices[index],init_indices[index+1]):
                    self.assertEqual((self.initBoard[i][j] not in taken), True, 'initial filled matrix contains duplicates')
                    taken.append(self.initBoard[i][j])

class TestBoardSubsetMethods(unittest.TestCase):  
    def setUp(self):
        self.initBoard = initialize_board()
        
    def test_3x3_generation(self):
        for i in range(9):
            mx = get_3x3(self.initBoard,i)
            self.assertEqual(len(mx),3, 'incorrect 3x3 length')
            self.assertEqual([len(i) for i in mx],[3]*3, 'incorrect 3x3 width')
            test_i,test_j = [(i%3)*3,int(i/3)*3]
            self.assertEqual(self.initBoard[test_i][test_j],mx[0][0], 'incorrect top corner value in 3x3 generation')
            
    def test_ix_to_3x3(self):
        i = 0
        j = 0
        #test
        
        mx = ix_to_3x3(self.initBoard, i, j)
        self.assertEqual(mx, get_3x3(self.initBoard,0),'incorrect conversion of index to 3x3')
        
        #test
        i = 4
        j = 8
        
        mx = ix_to_3x3(self.initBoard, i, j)
        self.assertEqual(mx, get_3x3(self.initBoard, 5), 'incorrect conversion of index to 3x3')
        
class TestValidityMethods(unittest.TestCase):
    def setUp(self):
        self.initBoard = initialize_board()
        
    def test_row_validity_check(self):
        row = self.initBoard[0]
        for v in row:
            self.assertFalse(validRowInsert(self.initBoard,0,3,v),'row validity check failed (false positive)')
        
        available = list(set(range(1,10)) - set(row))
        for a in available:
            self.assertTrue(validRowInsert(self.initBoard,0,3,a),'row validity check failed (false negative)')

        
    def test_column_validity_check(self):
        column = [x[0] for x in self.initBoard]
        for v in column:
            self.assertFalse(validColumnInsert(self.initBoard,3,0,v),'column validity check failed (false positive)')
        
        available = list(set(range(1,10)) - set(column))
        for a in available:
            self.assertTrue(validColumnInsert(self.initBoard,3,0,a), 'column validity check failed (false negative)')

        
    
    def test_3x3_validity_check(self):
        self.initBoard[4][4] = 0
        mx = get_3x3(self.initBoard, 4)

        
        taken = sum(mx,[])
        for t in taken:
             self.assertFalse(valid3x3Insert(self.initBoard,4,4,t),'3x3 validity check failed (false positive)')
        
        available = list(set(range(1,10)) - set(taken))[0]
        self.assertTrue(valid3x3Insert(self.initBoard,4,4,available),'3x3 validity check failed (false negative)')
        
        
        
class SolutionTests(unittest.TestCase):
    def setUp(self):
        self.initBoard = initialize_board()
        self.impossibleBoard = initialize_impossible_board()
    
    def test_solution(self):
        solution = solve(self.initBoard)[1]
        for i in range(len(self.initBoard)):
            unique_vals_row = len(set(solution[i]))
            unique_vals_column = len(set(get_column(solution,i)))
            unique_vals_square = len(set(sum(get_3x3(solution,i),[])))
            
            
            
            self.assertEqual(unique_vals_row,9, "Row " + str(i) + "has duplicate values")
            self.assertEqual(unique_vals_column,9, "Column" + str(i) + " has duplicate values")
            self.assertEqual(unique_vals_square,9, "Square" + str(i) + " has duplicate values")

            
            
    
    def test_impossible(self):
        x = solve(self.impossibleBoard)
        self.assertFalse(x[0],"Solved impossible board")
    
    
        

    
def suite():
    suite = unittest.TestSuite()
    
    suite.addTest(BoardSetUpTestCase('test_initial_board_size'))
    suite.addTest(BoardSetUpTestCase('test_initial_board_values'))
    suite.addTest(BoardSetUpTestCase('test_initial_diagonal_matrix_element_filling'))
    suite.addTest(BoardSetUpTestCase('test_initial_diagonal_matrix_validity'))
    suite.addTest(BoardSetUpTestCase('test_initial_diagonal_matrix_zero_filling'))
    
    suite.addTest(TestBoardSubsetMethods('test_3x3_generation'))
    suite.addTest(TestBoardSubsetMethods('test_ix_to_3x3'))

    suite.addTest(TestValidityMethods('test_row_validity_check'))
    suite.addTest(TestValidityMethods('test_column_validity_check'))
    suite.addTest(TestValidityMethods('test_3x3_validity_check'))
    
    suite.addTest(SolutionTests('test_solution'))
    suite.addTest(SolutionTests('test_impossible'))


    return suite

if __name__ == '__main__':
    runner = unittest.TextTestRunner()
    runner.run(suite())
    
    
